package cmd

import (
	"errors"
	"os"
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
func SwapApps(args []string) int {
	if len(args) != 2 {
		utils.PrintError(`usage: tess-patcher swap-apps <Spotify's Apps folder> <staged folder>`)
		return 1
	}
	dest, src := filepath.Clean(args[0]), filepath.Clean(args[1])
	// Only Spotify's own interface folder: a typo must never empty some other folder and fill it with Spotify's files.
	if !filepath.IsAbs(dest) || !strings.HasSuffix(dest, filepath.Join("Contents", "Resources", "Apps")) {
		utils.PrintError(dest + ` is not a Spotify "Contents/Resources/Apps" folder; nothing was changed`)
		return 1
	}
	if st, err := os.Stat(dest); err == nil && !st.IsDir() {
		utils.PrintError(dest + " is not a folder; nothing was changed")
		return 1
	}
	appDestPath = dest
	// The source is checked by the fill step, after swapApps has already put back the original of an interrupted
	// swap: a failed restore must repair Spotify even when the staged copy it wanted is gone.
	if err := swapApps(func(dir string) error {
		if st, err := os.Stat(src); err != nil || !st.IsDir() {
			return errors.New("the staged folder is missing or is not a folder")
		}
		return utils.Copy(src, dir, true, nil)
	}); err != nil {
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
