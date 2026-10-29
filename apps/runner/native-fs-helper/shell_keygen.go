package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/ssh"
)

const shellHostKeyName = "shell_host_ed25519"

func runShellKeygen(arguments []string, output io.Writer) error {
	flags := flag.NewFlagSet("shell-keygen", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	outputDirectory := flags.String("out", "", "host-key directory")
	if err := flags.Parse(arguments); err != nil || *outputDirectory == "" || flags.NArg() != 0 {
		return errors.New("usage: opensteer-native-fs shell-keygen --out <dir>")
	}
	if err := os.MkdirAll(*outputDirectory, 0700); err != nil {
		return fmt.Errorf("create shell host-key directory: %w", err)
	}
	privatePath := filepath.Join(*outputDirectory, shellHostKeyName)
	signer, err := loadShellHostKey(privatePath)
	if errors.Is(err, os.ErrNotExist) {
		signer, err = generateShellHostKey(privatePath)
	}
	if err != nil {
		return err
	}
	if signer.PublicKey().Type() != ssh.KeyAlgoED25519 {
		return errors.New("shell host key is not Ed25519")
	}
	public := ssh.MarshalAuthorizedKey(signer.PublicKey())
	if err := writeAtomicFile(privatePath+".pub", public, 0644); err != nil {
		return fmt.Errorf("write shell host public key: %w", err)
	}
	_, err = fmt.Fprintln(output, strings.TrimSpace(string(public)))
	return err
}

func generateShellHostKey(path string) (ssh.Signer, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate shell host key: %w", err)
	}
	block, err := ssh.MarshalPrivateKey(privateKey, "opensteer shell host key")
	if err != nil {
		return nil, fmt.Errorf("marshal shell host key: %w", err)
	}
	if err := writeAtomicFile(path, pem.EncodeToMemory(block), 0600); err != nil {
		return nil, fmt.Errorf("write shell host key: %w", err)
	}
	return loadShellHostKey(path)
}

func loadShellHostKey(path string) (ssh.Signer, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0600); err != nil {
		return nil, fmt.Errorf("secure shell host key: %w", err)
	}
	signer, err := ssh.ParsePrivateKey(content)
	if err != nil {
		return nil, fmt.Errorf("parse shell host key: %w", err)
	}
	return signer, nil
}

func writeAtomicFile(path string, content []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".opensteer-key-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
