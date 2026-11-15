//go:build unix

package cmd

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Tess: the signed swap-apps must not be able to reach any folder but the one it checked.
//
// The check reads the bundle's Info.plist and opens Resources, and then a plain path would let whoever started the
// command replace Resources with a symlink before the copy or the renames run: the swap would copy into, rename aside
// and then delete whatever that link points at. That is not hypothetical — with the path-based version an unrelated
// folder's `Apps` was replaced, its own file deleted, and the command exited 0.
//
// So the folder that was checked is opened while it is being checked — bundle, then Contents, then Resources, each with
// O_NOFOLLOW relative to the one above it — and every create, rename and delete below is an …at call on it. A descriptor
// cannot be redirected: replacing Resources after the check leaves the swap writing through the descriptor it already
// holds, and the re-check before each rename sees that the path no longer names the same folder and stops, putting the
// original back.

const (
	appsName = "Apps"
	// Beside Apps, inside the folder the descriptor holds: never a name a caller can point somewhere else.
	newName = appsName + ".tess-new"
	oldName = appsName + ".tess-old"
)

var errFolderMoved = errors.New("Spotify's folder was replaced while the new files were being copied; nothing was switched in")

// checkSpotifyApps answers "is this really Spotify's own interface folder?" and returns that folder already open, with
// the identity it was checked as. Resolving happens once, at the start; nothing below resolves a path again, so the
// plist that proves the bundle and the folder that is swapped are the same objects rather than the same words.
//
// A string ending is not enough. `…/NotContents/Resources/Apps` ends in the same words, and a `Resources` that is a
// symlink to somewhere else ends in them too, yet the swap would rename that folder aside and then delete it. So the
// path must end in a separator-bounded `Contents/Resources/Apps`, and its parent must still end in `Contents/Resources`
// after its symlinks are resolved (which is what lets `/var` stand for `/private/var`, and what refuses a symlinked
// `Resources`).
//
// Order matters. Reading the plist is the slow step (a binary plist goes through PlistBuddy), so Resources is opened and
// its device and inode recorded *before* it: a real folder moved into that name while the read runs no longer matches
// the path afterwards, and the command stops before it creates anything. The old order validated a path, then opened it,
// so a folder swapped in during the read was later compared against its own inode and accepted.
func checkSpotifyApps(dest string) (*appsSwap, error) {
	suffix := string(filepath.Separator) + filepath.Join("Contents", "Resources", "Apps")
	folder := string(filepath.Separator) + filepath.Join("Contents", "Resources")
	if !filepath.IsAbs(dest) || len(dest) <= len(suffix) || !strings.HasSuffix(dest, suffix) {
		return nil, errors.New(`not a Spotify "Contents/Resources/Apps" folder`)
	}
	// A run killed between the two renames leaves Apps absent, so only the parent is resolved: it still has to be a
	// real Resources folder, which is all "Apps is missing" says about the folder that is about to come back.
	resolved, err := filepath.EvalSymlinks(filepath.Dir(dest))
	if err != nil || len(resolved) <= len(folder) || !strings.HasSuffix(resolved, folder) {
		return nil, errors.New(`its symlinks lead outside a "Contents/Resources/Apps" folder`)
	}
	bundle := filepath.Dir(filepath.Dir(resolved))
	if filepath.Ext(bundle) != ".app" {
		return nil, errors.New(`not inside an ".app" bundle`)
	}
	bfd, err := openNoFollow(bundle)
	if err != nil {
		return nil, errors.New("its bundle cannot be opened: " + err.Error())
	}
	defer unix.Close(bfd)
	cfd, err := unix.Openat(bfd, "Contents", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("its Contents folder cannot be opened: " + err.Error())
	}
	defer unix.Close(cfd)
	rfd, err := unix.Openat(cfd, "Resources", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("its Resources folder cannot be opened: " + err.Error())
	}
	var st unix.Stat_t
	if err := unix.Fstat(rfd, &st); err != nil {
		unix.Close(rfd)
		return nil, err
	}
	s := &appsSwap{fd: rfd, path: resolved, dev: uint64(st.Dev), ino: uint64(st.Ino)}
	if err := s.sameFolder(); err != nil {
		s.close()
		return nil, errors.New("its Resources folder moved while it was being checked")
	}
	id, err := bundleIdentifierAt(cfd)
	if err != nil {
		s.close()
		return nil, errors.New("its Info.plist cannot be read: " + err.Error())
	}
	if id != spotifyBundleID {
		s.close()
		return nil, errors.New(`it belongs to "` + id + `", not ` + spotifyBundleID)
	}
	// The plist read is where a caller could act; the folder it proved must still be the folder that is held.
	if err := s.sameFolder(); err != nil {
		s.close()
		return nil, errors.New("its Resources folder was replaced while it was being checked")
	}
	return s, nil
}

// bundleIdentifierAt reads Contents/Info.plist through the open Contents folder. The path is never joined and resolved
// again: the plist that names the bundle is the one inside the bundle the swap is about to write into.
func bundleIdentifierAt(contents int) (string, error) {
	fd, err := unix.Openat(contents, "Info.plist", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), "Info.plist")
	b, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		return "", err
	}
	if plistHook != nil {
		hook := plistHook
		plistHook = nil
		hook()
	}
	return plistIdentifier(b)
}

func (s *appsSwap) close() {
	if s.fd >= 0 {
		unix.Close(s.fd)
		s.fd = -1
	}
}

// swapAppsAt replaces the Apps folder inside the Resources folder checkSpotifyApps opened and validated, with a folder
// built beside it and filled by fill, which writes only through the descriptor it is given.
func swapAppsAt(s *appsSwap, fill func(dirfd int) error) error {
	defer s.close()
	return s.swap(fill)
}

func (s *appsSwap) swap(fill func(dirfd int) error) error {
	if err := s.sameFolder(); err != nil {
		return err
	}
	// A run that stopped between the two renames: put the original back first, through the same descriptor.
	if _, err := s.lstat(appsName); errors.Is(err, unix.ENOENT) {
		if _, err := s.lstat(oldName); err == nil {
			if err := unix.Renameat(s.fd, oldName, s.fd, appsName); err != nil {
				return err
			}
		}
	}
	if err := removeAllAt(s.fd, newName); err != nil {
		return err
	}
	if err := unix.Mkdirat(s.fd, newName, 0o755); err != nil {
		return err
	}
	nfd, err := unix.Openat(s.fd, newName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		removeAllAt(s.fd, newName)
		return err
	}
	err = fill(nfd)
	complete := err == nil && completeAt(nfd)
	unix.Close(nfd)
	if err != nil {
		removeAllAt(s.fd, newName)
		return err
	}
	if !complete {
		removeAllAt(s.fd, newName)
		return errors.New("the new interface files are incomplete; Spotify was left as it was")
	}
	if err := s.sameFolder(); err != nil {
		removeAllAt(s.fd, newName)
		return err
	}
	removeAllAt(s.fd, oldName)
	if err := unix.Renameat(s.fd, appsName, s.fd, oldName); err != nil && !errors.Is(err, unix.ENOENT) {
		removeAllAt(s.fd, newName)
		return err
	}
	if err := s.sameFolder(); err != nil {
		unix.Renameat(s.fd, oldName, s.fd, appsName)
		removeAllAt(s.fd, newName)
		return err
	}
	if err := unix.Renameat(s.fd, newName, s.fd, appsName); err != nil {
		unix.Renameat(s.fd, oldName, s.fd, appsName)
		removeAllAt(s.fd, newName)
		return err
	}
	removeAllAt(s.fd, oldName) // a leftover here is harmless; the next run clears it
	return nil
}

// sameFolder answers "is the folder this swap holds still the folder Spotify points at?". The descriptor pins its own
// inode, so that half can only fail if something is very wrong; the path half is the one that matters, because a
// Resources replaced by a symlink or by a new folder means the swap would finish somewhere Spotify does not look.
func (s *appsSwap) sameFolder() error {
	var st unix.Stat_t
	if err := unix.Fstat(s.fd, &st); err != nil {
		return err
	}
	if uint64(st.Dev) != s.dev || uint64(st.Ino) != s.ino {
		return errFolderMoved
	}
	if err := unix.Stat(s.path, &st); err != nil {
		return errFolderMoved
	}
	if uint64(st.Dev) != s.dev || uint64(st.Ino) != s.ino {
		return errFolderMoved
	}
	return nil
}

func (s *appsSwap) lstat(name string) (unix.Stat_t, error) {
	var st unix.Stat_t
	err := unix.Fstatat(s.fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return st, err
}

// openNoFollow opens path, a directory whose symlinks are already resolved, one component at a time from /, refusing a
// symlink at every step. Nothing on the way can be pointed somewhere else after this call: each one is opened once and
// the next is opened relative to it.
func openNoFollow(path string) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" {
			continue
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

// removeAllAt is os.RemoveAll, relative to a directory descriptor: it never leaves the folder and never follows a link
// it finds inside it.
func removeAllAt(dirfd int, name string) error {
	var st unix.Stat_t
	if err := unix.Fstatat(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return unix.Unlinkat(dirfd, name, 0)
	}
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	names, err := readDirNames(fd)
	if err == nil {
		for _, child := range names {
			if err = removeAllAt(fd, child); err != nil {
				break
			}
		}
	}
	unix.Close(fd)
	if err != nil {
		return err
	}
	return unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
}

func readDirNames(fd int) ([]string, error) {
	dup, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(dup), "dir")
	defer f.Close()
	return f.Readdirnames(-1)
}

// copyTreeAt is utils.Copy's tree walk with every write aimed at a descriptor: a folder or a file planted at a name
// inside the new folder (a link, a second symlinked Apps) is never followed, and the bytes can only land in the folder
// the swap opened.
func copyTreeAt(dirfd int, src string, stepped func()) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		from := filepath.Join(src, name)
		if e.IsDir() {
			if err := unix.Mkdirat(dirfd, name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
				return err
			}
			fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return err
			}
			err = copyTreeAt(fd, from, stepped)
			unix.Close(fd)
			if err != nil {
				return err
			}
			continue
		}
		if err := copyFileAt(dirfd, from, name); err != nil {
			return err
		}
		if stepped != nil {
			stepped()
		}
	}
	return nil
}

func copyFileAt(dirfd int, src, name string) error {
	sf, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sf.Close()
	fd, err := unix.Openat(dirfd, name, unix.O_WRONLY|unix.O_CREAT|unix.O_TRUNC|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o700)
	if err != nil {
		return err
	}
	df := os.NewFile(uintptr(fd), name)
	_, err = io.Copy(df, sf)
	if cerr := df.Close(); err == nil {
		err = cerr
	}
	return err
}

// completeAt is looksComplete on an open folder: Spotify's interface is there, packed or unpacked.
func completeAt(fd int) bool {
	for _, rel := range []string{"xpui.spa", "xpui/index.html"} {
		var st unix.Stat_t
		if err := unix.Fstatat(fd, rel, &st, unix.AT_SYMLINK_NOFOLLOW); err == nil && st.Mode&unix.S_IFMT == unix.S_IFREG && st.Size > 0 {
			return true
		}
	}
	return false
}
