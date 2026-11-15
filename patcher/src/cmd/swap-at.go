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
// The check resolves symlinks and validates the bundle, and then a plain path would let whoever started the command
// replace Resources with a symlink before the copy or the renames run: the swap would copy into, rename aside and then
// delete whatever that link points at. That is not hypothetical — with the path-based version an unrelated folder's
// `Apps` was replaced, its own file deleted, and the command exited 0.
//
// So the folder that was checked is opened once, as a descriptor, walking every component from / with O_NOFOLLOW, and
// every create, rename and delete below is an …at call on it. A descriptor cannot be redirected: replacing Resources
// after the check leaves the swap writing through the descriptor it already holds, and the re-check before each rename
// sees that the path no longer names the same folder and stops, putting the original back.

const (
	appsName = "Apps"
	// Beside Apps, inside the folder the descriptor holds: never a name a caller can point somewhere else.
	newName = appsName + ".tess-new"
	oldName = appsName + ".tess-old"
)

var errFolderMoved = errors.New("Spotify's folder was replaced while the new files were being copied; nothing was switched in")

// appsSwap is Spotify's Resources folder, open, plus the identity the check saw so it can be compared again later.
type appsSwap struct {
	fd   int
	path string // the resolved path, only used to notice it being replaced
	dev  uint64
	ino  uint64
}

// swapAppsAt replaces the Apps folder inside resources (already resolved and validated by checkSpotifyApps) with a
// folder built beside it and filled by fill, which writes only through the descriptor it is given.
func swapAppsAt(resources string, fill func(dirfd int) error) error {
	fd, err := openNoFollow(resources)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	s := &appsSwap{fd: fd, path: resources, dev: uint64(st.Dev), ino: uint64(st.Ino)}
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
