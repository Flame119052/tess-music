package cmd

import (
	"errors"
	"os"
	"path/filepath"
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
