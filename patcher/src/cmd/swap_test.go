package cmd

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The release gate: Spotify's interface folder must never be left missing or half-written, whatever fails.
func setupApps(t *testing.T) string {
	t.Helper()
	res := t.TempDir()
	appDestPath = filepath.Join(res, "Apps")
	os.MkdirAll(appDestPath, 0o755)
	os.WriteFile(filepath.Join(appDestPath, "xpui.spa"), []byte("original"), 0o644)
	return res
}
func appsHas(t *testing.T, want string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(appDestPath, "xpui.spa"))
	if err != nil || string(b) != want {
		t.Fatalf("Spotify's interface changed or is missing: %q, %v", b, err)
	}
}
func good(dir string) error { return os.WriteFile(filepath.Join(dir, "xpui.spa"), []byte("new"), 0o644) }

func TestSwapReplaces(t *testing.T) {
	setupApps(t)
	if err := swapApps(good); err != nil {
		t.Fatal(err)
	}
	appsHas(t, "new")
}
func TestSwapFailedCopyLeavesSpotify(t *testing.T) {
	setupApps(t)
	if err := swapApps(func(string) error { return errors.New("copy blocked") }); err == nil {
		t.Fatal("expected an error")
	}
	appsHas(t, "original")
}
func TestSwapIncompleteLeavesSpotify(t *testing.T) {
	setupApps(t)
	if err := swapApps(func(dir string) error { return os.WriteFile(filepath.Join(dir, "login.spa"), []byte("x"), 0o644) }); err == nil {
		t.Fatal("expected an error")
	}
	appsHas(t, "original")
}
func TestSwapBlockedFolderLeavesSpotify(t *testing.T) {
	res := setupApps(t)
	os.Chmod(res, 0o555) // like macOS refusing changes inside Spotify
	defer os.Chmod(res, 0o755)
	if err := swapApps(good); err == nil {
		t.Fatal("expected an error")
	}
	appsHas(t, "original")
}
func TestSwapRecoversInterruptedRun(t *testing.T) {
	setupApps(t)
	os.Rename(appDestPath, appDestPath+".tess-old") // stopped between the two renames
	if err := swapApps(func(string) error { return errors.New("fail") }); err == nil {
		t.Fatal("expected an error")
	}
	appsHas(t, "original")
}
