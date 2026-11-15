//go:build !unix

package cmd

import "errors"

// Tess only runs on macOS. The descriptor-relative swap needs …at calls, so this keeps the tree buildable elsewhere
// and refuses the command rather than falling back to a path-based swap that a caller could redirect.
func swapAppsAt(string, func(dirfd int) error) error {
	return errors.New("swap-apps is only supported on macOS")
}
