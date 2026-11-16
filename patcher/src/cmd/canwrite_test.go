package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

// can-write asks macOS whether Tess may change Spotify's files at all. It must never touch anything that is already
// there: a predictable probe name used to follow a planted link and truncate its target inside Spotify's bundle.
func TestCanWriteProbeLeavesNothingBehind(t *testing.T) {
	dir := t.TempDir()
	if code := CanWrite([]string{dir}); code != 0 {
		t.Fatalf("a writable folder should answer 0, got %d", code)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the probe left a file behind: %s", entries[0].Name())
	}
}

func TestCanWriteProbeIgnoresAPlantedFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	// exactly the name the old probe used, pointed at a file someone else wants emptied
	link := filepath.Join(dir, ".tess-can-write")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if code := CanWrite([]string{dir}); code != 0 {
		t.Fatalf("a writable folder should answer 0, got %d", code)
	}
	if b, err := os.ReadFile(target); err != nil || string(b) != "keep me" {
		t.Fatalf("a planted link was followed and its target changed: %q, %v", b, err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("a planted link was removed: %v", err)
	}
}

func TestCanWriteProbeReadOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(dir, 0o755)
	if code := CanWrite([]string{dir}); code != 4 {
		t.Fatalf("a folder Tess cannot write should answer 4 (EACCES), got %d", code)
	}
}
