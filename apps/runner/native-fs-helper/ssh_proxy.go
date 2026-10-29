package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

const (
	maxRelayLineBytes = 4 * 1024
	relayDeadline     = 10 * time.Second
)

type relayRequest struct {
	Target string `json:"target"`
}

type relayResponse struct {
	Message *string `json:"message,omitempty"`
	OK      *bool   `json:"ok"`
}

func runSSHProxy(arguments []string, input io.Reader, output io.Writer, errorOutput io.Writer) int {
	flags := flag.NewFlagSet("ssh-proxy", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	relay := flags.String("relay", "", "relay socket")
	if err := flags.Parse(arguments); err != nil || *relay == "" || flags.NArg() != 1 || flags.Arg(0) == "" {
		fmt.Fprintln(errorOutput, "usage: opensteer-native-fs ssh-proxy --relay <socket> <target>")
		return 255
	}
	connection, err := net.DialTimeout("unix", *relay, relayDeadline)
	if err != nil {
		fmt.Fprintln(errorOutput, err)
		return 255
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(relayDeadline)); err != nil {
		fmt.Fprintln(errorOutput, err)
		return 255
	}
	encoded, err := json.Marshal(relayRequest{Target: flags.Arg(0)})
	if err != nil || len(encoded)+1 > maxRelayLineBytes {
		fmt.Fprintln(errorOutput, "Relay request is too large.")
		return 255
	}
	if _, err := connection.Write(append(encoded, '\n')); err != nil {
		fmt.Fprintln(errorOutput, err)
		return 255
	}
	reader := bufio.NewReaderSize(connection, maxRelayLineBytes)
	line, err := readBoundedLine(reader, maxRelayLineBytes)
	if err != nil {
		fmt.Fprintln(errorOutput, err)
		return 255
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var response relayResponse
	if err := decoder.Decode(&response); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		fmt.Fprintln(errorOutput, "Relay returned an invalid response.")
		return 255
	}
	if response.OK == nil {
		fmt.Fprintln(errorOutput, "Relay returned an invalid response.")
		return 255
	}
	if !*response.OK {
		if response.Message == nil || *response.Message == "" {
			fmt.Fprintln(errorOutput, "Relay returned an invalid refusal response.")
			return 255
		}
		fmt.Fprintln(errorOutput, *response.Message)
		return 255
	}
	if response.Message != nil {
		fmt.Fprintln(errorOutput, "Relay returned an invalid success response.")
		return 255
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		fmt.Fprintln(errorOutput, err)
		return 255
	}
	return proxyStreams(connection, reader, input, output, errorOutput)
}

func readBoundedLine(reader *bufio.Reader, limit int) ([]byte, error) {
	line, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) || len(line) > limit {
		return nil, errors.New("Relay response exceeds 4 KiB.")
	}
	if err != nil {
		return nil, fmt.Errorf("read relay response: %w", err)
	}
	return line, nil
}

func proxyStreams(connection net.Conn, bufferedRemote io.Reader, input io.Reader, output io.Writer, errorOutput io.Writer) int {
	remoteDone := make(chan error, 1)
	inputDone := make(chan error, 1)
	go func() {
		_, err := io.Copy(output, bufferedRemote)
		remoteDone <- err
	}()
	go func() {
		_, err := io.Copy(connection, input)
		if unixConnection, ok := connection.(*net.UnixConn); ok {
			_ = unixConnection.CloseWrite()
		}
		inputDone <- err
	}()

	select {
	case remoteErr := <-remoteDone:
		_ = connection.Close()
		if remoteErr != nil && !errors.Is(remoteErr, net.ErrClosed) {
			fmt.Fprintln(errorOutput, remoteErr)
			return 255
		}
		return 0
	case inputErr := <-inputDone:
		if inputErr != nil && !errors.Is(inputErr, net.ErrClosed) && !errors.Is(inputErr, os.ErrClosed) {
			fmt.Fprintln(errorOutput, inputErr)
			return 255
		}
		remoteErr := <-remoteDone
		if remoteErr != nil && !errors.Is(remoteErr, net.ErrClosed) {
			fmt.Fprintln(errorOutput, remoteErr)
			return 255
		}
		return 0
	}
}
