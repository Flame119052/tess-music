package cmd

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/spicetify/cli/src/utils"
)

// Tess: Spotify's interface folder (Apps) is never left missing or half-written.
//
// The upstream patcher deleted Apps and then copied the new files in. If anything stopped it in between (macOS's
// App Management protection, a full disk, a crash), Spotify was left with no interface at all and opened to a black
// window. swapApps instead builds the new folder next to Apps, checks it, and only then switches the two with
// renames in the same folder; if a rename fails the original goes straight back. If macOS blocks writing at all, the
// very first step (making the new folder) fails and Spotify is untouched.
//
// This is the path-based swap `apply` and `backup` use, where the folder comes from the user's own Spicetify config.
// The signed swap-apps command, which a script or any other caller can point at a path, uses swapAppsAt instead: it
// does the same steps relative to an open descriptor, so replacing the path mid-copy cannot redirect them.
func swapApps(fill func(dir string) error) error {
	staged := appDestPath + ".tess-new"
	old := appDestPath + ".tess-old"
	// a run that stopped between the two renames: put the original back first
	if _, err := os.Stat(appDestPath); os.IsNotExist(err) {
		if _, err := os.Stat(old); err == nil {
			if err := os.Rename(old, appDestPath); err != nil {
				return err
			}
		}
	}
	os.RemoveAll(staged)
	if err := os.MkdirAll(staged, 0o755); err != nil {
		return err
	}
	if err := fill(staged); err != nil {
		os.RemoveAll(staged)
		return err
	}
	if !looksComplete(staged) {
		os.RemoveAll(staged)
		return errors.New("the new interface files are incomplete; Spotify was left as it was")
	}
	os.RemoveAll(old)
	if err := os.Rename(appDestPath, old); err != nil && !os.IsNotExist(err) {
		os.RemoveAll(staged)
		return err
	}
	if err := os.Rename(staged, appDestPath); err != nil {
		os.Rename(old, appDestPath)
		os.RemoveAll(staged)
		return err
	}
	os.RemoveAll(old) // a leftover here is harmless; the next run clears it
	return nil
}

// SwapApps replaces the folder at args[0] (Spotify's interface folder) with a complete copy of the staged folder at
// args[1]. It is the same checked swap apply uses, run inside this signed program: macOS's App Management protection
// denies that very copy when a script makes it with /usr/bin/ditto under /bin/zsh, which is how launchd starts Tess's
// helper, so a background theme update could never reach Spotify through a shell. Exit 0 swapped, 3 macOS blocked it,
// 4 the files belong to another user, 1 anything else.
//
// The check and the swap are the same folder, not the same path: checkSpotifyApps opens the bundle, reads its
// Info.plist and opens Resources relative to it, so a folder moved into that name between the check and the first write
// is refused rather than swapped. Every step after that runs relative to the descriptor it holds (swapAppsAt).
func SwapApps(args []string) int {
	if len(args) != 2 {
		utils.PrintError(`usage: tess-patcher swap-apps <Spotify's Apps folder> <staged folder>`)
		return 1
	}
	dest, src := filepath.Clean(args[0]), filepath.Clean(args[1])
	// Only Spotify's own interface folder: the swap renames the folder aside and then deletes it, so a typo or a
	// lookalike path must never be able to reach some other folder.
	swap, err := checkSpotifyApps(dest)
	if err != nil {
		utils.PrintError(dest + ": " + err.Error() + "; nothing was changed")
		return 1
	}
	appDestPath = dest
	// The source is checked by the fill step, after swapAppsAt has already put back the original of an interrupted
	// swap: a failed restore must repair Spotify even when the staged copy it wanted is gone.
	var stepped func()
	if swapHook != nil {
		hook, done := swapHook, false
		stepped = func() {
			if !done {
				done = true
				hook()
			}
		}
	}
	err = swapAppsAt(swap, func(dirfd int) error {
		if st, err := os.Stat(src); err != nil || !st.IsDir() {
			return errors.New("the staged folder is missing or is not a folder")
		}
		return copyTreeAt(dirfd, src, stepped)
	})
	if err != nil {
		utils.PrintError("Spotify's interface folder was left as it was: " + err.Error())
		if errors.Is(err, syscall.EPERM) {
			return 3
		}
		if errors.Is(err, syscall.EACCES) {
			return 4
		}
		return 1
	}
	return 0
}

// swapHook runs once, after the first file of the new folder is written. It is nil in the shipped binary; a test uses it
// to replace Resources with a symlink at the one moment a caller could, and so prove the swap cannot follow it.
var swapHook func()

// plistHook runs once, between reading Info.plist through the open bundle and validating what it says. It is nil in the
// shipped binary; a test uses it to move another real folder into Resources (or Contents) while the plist read is
// running, and so prove the folder that is swapped is the folder that was checked.
var plistHook func()

// appsSwap is Spotify's Resources folder, open, plus the identity the check saw so it can be compared again later. It is
// declared here rather than beside the descriptor steps so both builds know the type; those steps are in swap-at.go.
type appsSwap struct {
	fd   int
	path string // the resolved path, only used to notice it being replaced
	dev  uint64
	ino  uint64
}

const spotifyBundleID = "com.spotify.client"

// plistIdentifier returns CFBundleIdentifier from Info.plist bytes read through the open bundle. Spotify's real plist is
// a binary one and a test bundle's is XML: XML is read here in Go, and the binary form goes to plutil on stdin, so the
// bytes the bundle gave us are the bytes that name it and no outside tool is ever handed a path to open again.
//
// The binary form used to be copied into a temporary file that PlistBuddy was pointed at. Whoever runs the signed
// program could replace that file after the copy and before the read: another bundle's interface folder was then
// swapped, its own file deleted, and the command exited 0 while the bundle's plist still said com.example.other
// (#110 re-check 4, 6 of 12 runs). A pipe has no name to replace, so the read proves the bundle it was opened from.
func plistIdentifier(b []byte) (string, error) {
	if !bytes.HasPrefix(b, []byte("bplist")) {
		return xmlStringValue(b, "CFBundleIdentifier")
	}
	cmd := exec.Command("/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", "-")
	cmd.Stdin = bytes.NewReader(b)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// xmlStringValue returns the first <string> in a plist that follows the <key>name</key>.
func xmlStringValue(b []byte, name string) (string, error) {
	d := xml.NewDecoder(bytes.NewReader(b))
	want := false
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		if se.Name.Local == "key" {
			var k string
			if err := d.DecodeElement(&k, &se); err != nil {
				return "", err
			}
			want = strings.TrimSpace(k) == name
			continue
		}
		if se.Name.Local == "string" && want {
			var v string
			if err := d.DecodeElement(&v, &se); err != nil {
				return "", err
			}
			return v, nil
		}
		want = false
	}
	return "", errors.New(name + " is missing")
}

// Spotify's interface is there: either its packed form (xpui.spa) or an unpacked folder with a page to load
func looksComplete(dir string) bool {
	if st, err := os.Stat(filepath.Join(dir, "xpui.spa")); err == nil && st.Size() > 0 {
		return true
	}
	if st, err := os.Stat(filepath.Join(dir, "xpui", "index.html")); err == nil && st.Size() > 0 {
		return true
	}
	return false
}
