package cmd

import (
	"errors"
	"os"
	"syscall"
)

// CanWrite answers "may Tess change files inside this folder at all?" for the folder it is given: 0 yes, 3 macOS's App
// Management protection blocked it (EPERM), 4 the files belong to another user (EACCES), 1 anything else.
//
// It runs as the patcher itself, so macOS judges it exactly like a real patch, and it only creates and removes one empty
// file. That file is only ever *created*: CreateTemp uses O_EXCL with a random name, so a link or a folder planted at a
// known path can neither be followed nor truncated. Litter is not a permission problem, so a failed unlink is ignored.
func CanWrite(args []string) int {
	if len(args) != 1 {
		return 1
	}
	code := func(err error) int {
		if errors.Is(err, syscall.EPERM) {
			return 3
		}
		if errors.Is(err, syscall.EACCES) {
			return 4
		}
		return 1
	}
	f, err := os.CreateTemp(args[0], ".tess-can-write-")
	if err != nil {
		return code(err)
	}
	probe := f.Name()
	f.Close()
	os.Remove(probe)
	return 0
}
