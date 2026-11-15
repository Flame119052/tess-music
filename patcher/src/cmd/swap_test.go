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
func good(dir string) error {
	return os.WriteFile(filepath.Join(dir, "xpui.spa"), []byte("new"), 0o644)
}

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

// swap-apps is the path the updater and the doctor use: macOS's App Management protection denies the same copy when a
// shell makes it, so the copy and the swap have to happen inside the signed patcher.
func setupSpotify(t *testing.T) (apps, staged string) {
	t.Helper()
	res := t.TempDir()
	apps = filepath.Join(res, "Spotify.app", "Contents", "Resources", "Apps")
	staged = filepath.Join(res, "staged")
	os.MkdirAll(apps, 0o755)
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(apps, "xpui.spa"), []byte("original"), 0o644)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	return apps, staged
}

func TestSwapAppsReplaces(t *testing.T) {
	apps, staged := setupSpotify(t)
	if code := SwapApps([]string{apps, staged}); code != 0 {
		t.Fatalf("swap-apps exit %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "new" {
		t.Fatalf("the staged interface was not switched in: %q, %v", b, err)
	}
	for _, leftover := range []string{apps + ".tess-new", apps + ".tess-old"} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("left behind %s", leftover)
		}
	}
}

func TestSwapAppsBlockedWriteLeavesSpotify(t *testing.T) {
	apps, staged := setupSpotify(t)
	resources := filepath.Dir(apps)
	os.Chmod(resources, 0o555) // like macOS refusing new files inside Spotify
	defer os.Chmod(resources, 0o755)
	code := SwapApps([]string{apps, staged})
	if code != 3 && code != 4 {
		t.Fatalf("a blocked write should name the reason (3 or 4), got %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("Spotify's interface changed or is missing: %q, %v", b, err)
	}
	if _, err := os.Stat(apps + ".tess-new"); !os.IsNotExist(err) {
		t.Fatal("a blocked write left a half-made folder beside Spotify's interface")
	}
}

func TestSwapAppsFailedCopyLeavesSpotify(t *testing.T) {
	apps, staged := setupSpotify(t)
	unreadable := filepath.Join(staged, "zz.bin")
	os.WriteFile(unreadable, []byte("x"), 0o000) // fails after xpui.spa was already copied
	code := SwapApps([]string{apps, staged})
	if code == 0 {
		t.Fatal("a copy that fails partway must not report success")
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("Spotify's interface changed or is missing: %q, %v", b, err)
	}
	if _, err := os.Stat(apps + ".tess-new"); !os.IsNotExist(err) {
		t.Fatal("a failed copy left a half-made folder beside Spotify's interface")
	}
}

func TestSwapAppsRecoversInterruptedSwap(t *testing.T) {
	apps, staged := setupSpotify(t)
	// the exact state a run killed between the two renames leaves: Apps gone, the original in .tess-old, a partial copy
	os.Rename(apps, apps+".tess-old")
	os.MkdirAll(apps+".tess-new", 0o755)
	os.WriteFile(filepath.Join(apps+".tess-new", "xpui.spa"), []byte("partial"), 0o644)
	if code := SwapApps([]string{apps, filepath.Join(filepath.Dir(staged), "missing")}); code == 0 {
		t.Fatal("a missing staged folder must not report success")
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("the next run did not put Spotify's own interface back: %q, %v", b, err)
	}
	// and that same next run, with a good staged folder, finishes the job
	if code := SwapApps([]string{apps, staged}); code != 0 {
		t.Fatalf("swap-apps exit %d after recovering", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "new" {
		t.Fatalf("the staged interface was not switched in after recovery: %q, %v", b, err)
	}
	for _, leftover := range []string{apps + ".tess-new", apps + ".tess-old"} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("left behind %s", leftover)
		}
	}
}

func TestSwapAppsRefusesAnotherFolder(t *testing.T) {
	res := setupApps(t)
	if code := SwapApps([]string{appDestPath, res}); code == 0 {
		t.Fatal("a folder that is not Spotify's interface folder must be refused")
	}
	appsHas(t, "original")
}

func TestSwapAppsMissingStagedFolder(t *testing.T) {
	apps, staged := setupSpotify(t)
	if code := SwapApps([]string{apps, filepath.Join(filepath.Dir(staged), "missing")}); code == 0 {
		t.Fatal("a missing staged folder must be refused")
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("Spotify's interface changed or is missing: %q, %v", b, err)
	}
}
