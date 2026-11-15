//go:build !unix

package cmd

import "errors"

// Tess only runs on macOS. The check and the swap need …at calls and a held descriptor, so this keeps the tree
// buildable elsewhere and refuses the command rather than falling back to a path-based swap a caller could redirect.
func checkSpotifyApps(string) (*appsSwap, error) {
	return nil, errors.New("swap-apps is only supported on macOS")
}

func swapAppsAt(*appsSwap, func(dirfd int) error) error {
	return errors.New("swap-apps is only supported on macOS")
}
