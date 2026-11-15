package cmd

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	apps = makeApp(t, res, "Spotify.app", "com.spotify.client")
	staged = filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	// Spotify's interface is a tree, not one file: the copy has to create folders through the descriptor too.
	os.MkdirAll(filepath.Join(staged, "xpui", "extensions"), 0o755)
	os.WriteFile(filepath.Join(staged, "xpui", "extensions", "theme.js"), []byte("js"), 0o644)
	return apps, staged
}

// makeApp builds a bundle shaped like a real one (Info.plist names its identifier) and returns its Apps folder.
func makeApp(t *testing.T, root, name, id string) string {
	t.Helper()
	app := filepath.Join(root, name)
	apps := filepath.Join(app, "Contents", "Resources", "Apps")
	os.MkdirAll(apps, 0o755)
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plistFor(id)), 0o644); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(apps, "xpui.spa"), []byte("original"), 0o644)
	os.WriteFile(filepath.Join(apps, "keep-me"), []byte("keep"), 0o644)
	return apps
}

func plistFor(id string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleIdentifier</key><string>` + id + `</string></dict></plist>`
}

func assertKept(t *testing.T, dir string) {
	t.Helper()
	if b, err := os.ReadFile(filepath.Join(dir, "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("a folder that is not Spotify's was changed: %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "keep-me")); err != nil {
		t.Fatalf("a folder that is not Spotify's was emptied: %v", err)
	}
}

func TestSwapAppsReplaces(t *testing.T) {
	apps, staged := setupSpotify(t)
	if code := SwapApps([]string{apps, staged}); code != 0 {
		t.Fatalf("swap-apps exit %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "new" {
		t.Fatalf("the staged interface was not switched in: %q, %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui", "extensions", "theme.js")); err != nil || string(b) != "js" {
		t.Fatalf("the folders inside the staged interface were not switched in: %q, %v", b, err)
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

// A name that ends in the right words is not the right folder: the words must start at a separator.
func TestSwapAppsRefusesLookalikeFolder(t *testing.T) {
	res := t.TempDir()
	look := filepath.Join(res, "NotContents", "Resources", "Apps")
	os.MkdirAll(look, 0o755)
	os.WriteFile(filepath.Join(look, "xpui.spa"), []byte("original"), 0o644)
	os.WriteFile(filepath.Join(look, "keep-me"), []byte("keep"), 0o644)
	staged := filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	if code := SwapApps([]string{look, staged}); code == 0 {
		t.Fatal("a lookalike path that is not inside a bundle must be refused")
	}
	assertKept(t, look)
}

// `Resources` as a symlink points the swap at a folder that is not the bundle's own, so the resolved path must keep the
// shape too. This is the same rule that lets /var stand for /private/var (the sandbox temp folders).
func TestSwapAppsRefusesSymlinkedResources(t *testing.T) {
	res := t.TempDir()
	victim := filepath.Join(res, "victim")
	os.MkdirAll(victim, 0o755)
	os.WriteFile(filepath.Join(victim, "xpui.spa"), []byte("original"), 0o644)
	os.WriteFile(filepath.Join(victim, "keep-me"), []byte("keep"), 0o644)
	app := filepath.Join(res, "Spotify.app")
	os.MkdirAll(filepath.Join(app, "Contents"), 0o755)
	os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plistFor("com.spotify.client")), 0o644)
	if err := os.Symlink(victim, filepath.Join(app, "Contents", "Resources")); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	staged := filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	dest := filepath.Join(app, "Contents", "Resources", "Apps")
	if code := SwapApps([]string{dest, staged}); code == 0 {
		t.Fatal("a Resources folder that is a symlink to somewhere else must be refused")
	}
	assertKept(t, victim)
}

// Another app's interface folder is not Spotify's, even with the same shape inside.
func TestSwapAppsRefusesAnotherApp(t *testing.T) {
	res := t.TempDir()
	apps := makeApp(t, res, "Other.app", "com.example.other")
	staged := filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	if code := SwapApps([]string{apps, staged}); code == 0 {
		t.Fatal("another app's interface folder must be refused")
	}
	assertKept(t, apps)
}

// The resolved path is allowed to differ from the typed one, as /var does from /private/var on every Mac.
func TestSwapAppsFollowsSymlinkedRoot(t *testing.T) {
	res := t.TempDir()
	real := filepath.Join(res, "real")
	os.MkdirAll(real, 0o755)
	apps := makeApp(t, real, "Spotify.app", "com.spotify.client")
	if err := os.Symlink(real, filepath.Join(res, "link")); err != nil {
		t.Skipf("cannot make a symlink here: %v", err)
	}
	staged := filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	linked := filepath.Join(res, "link", "Spotify.app", "Contents", "Resources", "Apps")
	if code := SwapApps([]string{linked, staged}); code != 0 {
		t.Fatalf("a symlinked root that still names Spotify must pass, exit %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "new" {
		t.Fatalf("the staged interface was not switched in: %q, %v", b, err)
	}
}

// The real Spotify ships a binary Info.plist, so the reader has to handle one: plutil makes the test file binary here.
func TestSwapAppsReadsABinaryPlist(t *testing.T) {
	res := t.TempDir()
	apps := makeApp(t, res, "Spotify.app", "com.spotify.client")
	plist := filepath.Join(res, "Spotify.app", "Contents", "Info.plist")
	if err := exec.Command("/usr/bin/plutil", "-convert", "binary1", plist).Run(); err != nil {
		t.Skipf("plutil cannot make a binary plist here: %v", err)
	}
	if b, err := os.ReadFile(plist); err != nil || !strings.HasPrefix(string(b), "bplist") {
		t.Fatalf("the plist is not binary: %v", err)
	}
	staged := filepath.Join(res, "staged")
	os.MkdirAll(staged, 0o755)
	os.WriteFile(filepath.Join(staged, "xpui.spa"), []byte("new"), 0o644)
	if code := SwapApps([]string{apps, staged}); code != 0 {
		t.Fatalf("a binary Info.plist must be read like an XML one, exit %d", code)
	}
	if b, err := os.ReadFile(filepath.Join(apps, "xpui.spa")); err != nil || string(b) != "new" {
		t.Fatalf("the staged interface was not switched in: %q, %v", b, err)
	}
}

// The check and the swap must be the same folder. Here Resources is moved aside and replaced by a symlink to an
// unrelated folder at the moment a caller can do it — after the check, partway through the copy. The swap holds a
// descriptor of the folder it checked, so the folder the link points at is never copied into, renamed or deleted, the
// run says so instead of exiting 0, and Spotify's own folder is still exactly as it was.
//
// The second staged file matters: a path-based copy finishes writing into the linked folder and then finds a complete
// interface there, which is how the old code renamed and deleted an unrelated folder and exited 0.
func TestSwapAppsAbortsWhenResourcesReplacedDuringCopy(t *testing.T) {
	apps, staged := setupSpotify(t)
	os.WriteFile(filepath.Join(staged, "a-first"), []byte("first"), 0o644)
	resources := filepath.Dir(apps)
	victim := filepath.Join(t.TempDir(), "elsewhere")
	victimApps := filepath.Join(victim, "Apps")
	os.MkdirAll(victimApps, 0o755)
	os.WriteFile(filepath.Join(victimApps, "xpui.spa"), []byte("original"), 0o644)
	os.WriteFile(filepath.Join(victimApps, "keep-me"), []byte("keep"), 0o644)
	moved := resources + "-real"
	swapHook = func() {
		swapHook = nil
		if err := os.Rename(resources, moved); err != nil {
			t.Errorf("cannot move Resources aside: %v", err)
			return
		}
		if err := os.Symlink(victim, resources); err != nil {
			t.Errorf("cannot put a symlink in its place: %v", err)
		}
	}
	defer func() { swapHook = nil }()
	if code := SwapApps([]string{apps, staged}); code == 0 {
		t.Fatal("a Resources folder swapped for a symlink during the copy must not report success")
	}
	assertKept(t, victimApps)
	if b, err := os.ReadFile(filepath.Join(moved, "Apps", "xpui.spa")); err != nil || string(b) != "original" {
		t.Fatalf("Spotify's own interface changed or is missing: %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(moved, "Apps.tess-new")); !os.IsNotExist(err) {
		t.Fatal("the aborted run left its half-made folder inside Spotify")
	}
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
