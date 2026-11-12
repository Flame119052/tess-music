// tess-verify checks that a downloaded file was signed by Tess's release key.
// Usage: tess-verify <file> <base64 signature>   (exit 0 = good, 1 = bad)
// The updater runs it before installing anything, since macOS's openssl can't check Ed25519.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
)

const publicKey = "XOYW72EMGoUz6Km+BpIgzTdliV6VzywqMmALhAdr1ws="

func main() {
	if len(os.Args) != 3 {
		os.Stderr.WriteString("usage: tess-verify <file> <base64 signature>\n")
		os.Exit(2)
	}
	key, _ := base64.StdEncoding.DecodeString(publicKey)
	sig, err := base64.StdEncoding.DecodeString(os.Args[2])
	if err != nil {
		os.Exit(1)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(ed25519.PublicKey(key), data, sig) {
		os.Exit(1)
	}
}
