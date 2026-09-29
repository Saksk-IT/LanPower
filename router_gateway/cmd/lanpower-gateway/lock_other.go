//go:build !linux

package main

import (
	"errors"
	"os"
)

func lockFile(_ *os.File) error { return errors.New("the gateway service requires Linux") }
func unlockFile(_ *os.File)     {}
