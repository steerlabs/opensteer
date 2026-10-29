//go:build linux || darwin

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"
)

const (
	sftpPacketInit     = 1
	sftpPacketVersion  = 2
	sftpPacketOpen     = 3
	sftpPacketClose    = 4
	sftpPacketRead     = 5
	sftpPacketWrite    = 6
	sftpPacketLstat    = 7
	sftpPacketFstat    = 8
	sftpPacketSetstat  = 9
	sftpPacketFsetstat = 10
	sftpPacketOpendir  = 11
	sftpPacketReaddir  = 12
	sftpPacketRemove   = 13
	sftpPacketMkdir    = 14
	sftpPacketRmdir    = 15
	sftpPacketRealpath = 16
	sftpPacketStat     = 17
	sftpPacketRename   = 18
	sftpPacketReadlink = 19
	sftpPacketSymlink  = 20
	sftpPacketStatus   = 101
	sftpPacketHandle   = 102
	sftpPacketData     = 103
	sftpPacketName     = 104
	sftpPacketAttrs    = 105
	sftpPacketExtended = 200

	sftpStatusOK               = 0
	sftpStatusEOF              = 1
	sftpStatusNoSuchFile       = 2
	sftpStatusPermissionDenied = 3
	sftpStatusFailure          = 4
	sftpStatusBadMessage       = 5
	sftpStatusOpUnsupported    = 8

	sftpOpenRead   = 0x00000001
	sftpOpenWrite  = 0x00000002
	sftpOpenAppend = 0x00000004
	sftpOpenCreate = 0x00000008
	sftpOpenTrunc  = 0x00000010
	sftpOpenExcl   = 0x00000020

	sftpAttrSize        = 0x00000001
	sftpAttrUIDGID      = 0x00000002
	sftpAttrPermissions = 0x00000004
	sftpAttrTimes       = 0x00000008
	sftpAttrExtended    = 0x80000000

	maxSFTPPacketBytes = 1024 * 1024
	maxSFTPDataBytes   = 256 * 1024
)

type shellShare struct {
	errorCode uint32
	errorText string
	mode      string
	path      string
	root      *os.Root
}

type shellSFTPHandle struct {
	append           bool
	directoryEntries []os.FileInfo
	directoryOffset  int
	file             *os.File
	namespacePath    string
	readable         bool
	share            *shellShare
	writable         bool
}

type shellSFTPServer struct {
	channel    uint32
	handles    map[string]*shellSFTPHandle
	nextHandle uint64
	reader     io.Reader
	session    *shellSession
	writer     io.Writer
}

type shellSFTPError struct {
	code    uint32
	denied  bool
	message string
}

func (value *shellSFTPError) Error() string { return value.message }

func openShellShares(policies []shellSharePolicy, emitter *shellRecordEmitter) []*shellShare {
	shares := make([]*shellShare, 0, len(policies))
	for _, policy := range policies {
		share := &shellShare{mode: policy.Mode, path: policy.Path}
		root, err := os.OpenRoot(policy.Path)
		if err == nil {
			share.root = root
		} else if errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ENOTDIR) {
			share.errorCode = sftpStatusNoSuchFile
			share.errorText = fmt.Sprintf("Shared folder is missing: %s", policy.Path)
		} else if errors.Is(err, fs.ErrPermission) || errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			share.errorCode = sftpStatusPermissionDenied
			share.errorText = fmt.Sprintf("Opensteer does not have permission to open shared folder %s.", policy.Path)
			emitter.audit(map[string]any{"kind": "denied", "what": "sftp", "detail": share.errorText})
		} else {
			share.errorCode = sftpStatusFailure
			share.errorText = fmt.Sprintf("Opensteer could not open shared folder %s.", policy.Path)
		}
		shares = append(shares, share)
	}
	sort.Slice(shares, func(left, right int) bool { return shares[left].path < shares[right].path })
	return shares
}

func (session *shellSession) closeShares() {
	for _, share := range session.shares {
		if share.root != nil {
			_ = share.root.Close()
		}
	}
}

func (session *shellSession) serveSFTP(channelID uint32, channel ssh.Channel) error {
	server := &shellSFTPServer{
		channel: channelID,
		handles: make(map[string]*shellSFTPHandle),
		reader:  shellActivityReader{reader: channel, idle: session.idle},
		session: session,
		writer:  shellActivityWriter{writer: channel, idle: session.idle},
	}
	defer server.closeHandles()
	return server.serve()
}

func (server *shellSFTPServer) serve() error {
	packetType, payload, err := server.readPacket()
	if err != nil {
		return err
	}
	if packetType != sftpPacketInit {
		return errors.New("SFTP session did not begin with SSH_FXP_INIT")
	}
	decoder := shellSFTPDecoder{content: payload}
	version, err := decoder.uint32()
	if err != nil || decoder.remaining() != 0 || version < 3 {
		return errors.New("SFTP client version is unsupported")
	}
	response := &shellSFTPEncoder{}
	response.uint32(3)
	for _, extension := range [][2]string{
		{"posix-rename@openssh.com", "1"},
		{"expand-path@openssh.com", "1"},
		{"fsync@openssh.com", "1"},
	} {
		response.string(extension[0])
		response.string(extension[1])
	}
	if err := server.writePacket(sftpPacketVersion, response.bytes()); err != nil {
		return err
	}
	for {
		packetType, payload, err = server.readPacket()
		if err != nil {
			return err
		}
		if err := server.dispatch(packetType, payload); err != nil {
			return err
		}
	}
}

func (server *shellSFTPServer) dispatch(packetType byte, payload []byte) error {
	decoder := shellSFTPDecoder{content: payload}
	id, err := decoder.uint32()
	if err != nil {
		return server.writeStatus(0, sftpStatusBadMessage, "Invalid SFTP request.")
	}
	switch packetType {
	case sftpPacketOpen:
		return server.open(id, &decoder)
	case sftpPacketClose:
		return server.close(id, &decoder)
	case sftpPacketRead:
		return server.read(id, &decoder)
	case sftpPacketWrite:
		return server.write(id, &decoder)
	case sftpPacketLstat:
		return server.stat(id, &decoder, false)
	case sftpPacketFstat:
		return server.fstat(id, &decoder)
	case sftpPacketSetstat:
		return server.setstat(id, &decoder, false)
	case sftpPacketFsetstat:
		return server.fsetstat(id, &decoder)
	case sftpPacketOpendir:
		return server.opendir(id, &decoder)
	case sftpPacketReaddir:
		return server.readdir(id, &decoder)
	case sftpPacketRemove:
		return server.remove(id, &decoder, false)
	case sftpPacketMkdir:
		return server.mkdir(id, &decoder)
	case sftpPacketRmdir:
		return server.remove(id, &decoder, true)
	case sftpPacketRealpath:
		return server.realpath(id, &decoder)
	case sftpPacketStat:
		return server.stat(id, &decoder, true)
	case sftpPacketRename:
		return server.rename(id, &decoder, false)
	case sftpPacketReadlink:
		return server.readlink(id, &decoder)
	case sftpPacketSymlink:
		return server.refuseLink(id, &decoder, "symlink")
	case sftpPacketExtended:
		return server.extended(id, &decoder)
	default:
		return server.writeStatus(id, sftpStatusOpUnsupported, "SFTP operation is unsupported.")
	}
}

func (server *shellSFTPServer) open(id uint32, decoder *shellSFTPDecoder) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil {
		return server.badMessage(id)
	}
	flags, err := decoder.uint32()
	if err != nil {
		return server.badMessage(id)
	}
	if _, err := decoder.attrs(); err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, err := server.sharedPath(requested, false)
	if err != nil {
		return server.writeError(id, err)
	}
	writable := flags&(sftpOpenWrite|sftpOpenAppend|sftpOpenCreate|sftpOpenTrunc) != 0
	mode := "read"
	if writable {
		mode = "write"
		if share.mode != "read-write" {
			return server.permission(id, fmt.Sprintf("Shared folder %s is read-only.", share.path))
		}
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.open", "channel": server.channel, "path": namespace, "mode": mode})
	resolved, err := resolveShellSharePath(share, relative, true, flags&sftpOpenCreate != 0)
	if err != nil {
		return server.writeError(id, err)
	}
	openFlags := unix.O_NONBLOCK | unix.O_NOFOLLOW
	switch {
	case flags&sftpOpenRead != 0 && writable:
		openFlags |= os.O_RDWR
	case writable:
		openFlags |= os.O_WRONLY
	default:
		openFlags |= os.O_RDONLY
	}
	if flags&sftpOpenCreate != 0 {
		openFlags |= os.O_CREATE
	}
	if flags&sftpOpenExcl != 0 {
		openFlags |= os.O_EXCL
	}
	file, openErr := share.root.OpenFile(resolved, openFlags, 0600)
	if openErr != nil {
		return server.writeError(id, shellErrorFromOS(openErr))
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		if statErr != nil {
			return server.writeError(id, shellErrorFromOS(statErr))
		}
		return server.permission(id, "Opensteer only opens regular files over SFTP.")
	}
	if flags&sftpOpenTrunc != 0 {
		if err := file.Truncate(0); err != nil {
			_ = file.Close()
			return server.writeError(id, shellErrorFromOS(err))
		}
	}
	handle := server.newHandle(&shellSFTPHandle{
		append: flags&sftpOpenAppend != 0, file: file, namespacePath: namespace,
		readable: flags&sftpOpenRead != 0 || !writable, share: share, writable: writable,
	})
	return server.writeHandle(id, handle)
}

func (server *shellSFTPServer) close(id uint32, decoder *shellSFTPDecoder) error {
	handleName, err := decoder.string(128)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	handle, ok := server.handles[handleName]
	if !ok {
		return server.writeStatus(id, sftpStatusFailure, "Invalid SFTP handle.")
	}
	delete(server.handles, handleName)
	if handle.file != nil {
		if err := handle.file.Close(); err != nil {
			return server.writeError(id, shellErrorFromOS(err))
		}
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) read(id uint32, decoder *shellSFTPDecoder) error {
	handle, offset, length, err := server.decodeTransfer(decoder)
	if err != nil {
		return server.writeError(id, err)
	}
	if handle.file == nil || !handle.readable || length > maxSFTPDataBytes {
		return server.writeStatus(id, sftpStatusFailure, "Invalid SFTP read.")
	}
	content := make([]byte, length)
	count, readErr := handle.file.ReadAt(content, int64(offset))
	if count > 0 {
		response := &shellSFTPEncoder{}
		response.uint32(id)
		response.rawString(content[:count])
		return server.writePacket(sftpPacketData, response.bytes())
	}
	if errors.Is(readErr, io.EOF) {
		return server.writeStatus(id, sftpStatusEOF, "End of file")
	}
	return server.writeError(id, shellErrorFromOS(readErr))
}

func (server *shellSFTPServer) write(id uint32, decoder *shellSFTPDecoder) error {
	handleName, err := decoder.string(128)
	if err != nil {
		return server.badMessage(id)
	}
	offset, err := decoder.uint64()
	if err != nil {
		return server.badMessage(id)
	}
	content, err := decoder.rawString(maxSFTPDataBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	handle, ok := server.handles[handleName]
	if !ok || handle.file == nil || !handle.writable || offset > math.MaxInt64 {
		return server.permission(id, "SFTP handle is not open for writing.")
	}
	if handle.append {
		info, statErr := handle.file.Stat()
		if statErr != nil {
			return server.writeError(id, shellErrorFromOS(statErr))
		}
		offset = uint64(info.Size())
	}
	count, writeErr := handle.file.WriteAt(content, int64(offset))
	if writeErr != nil {
		return server.writeError(id, shellErrorFromOS(writeErr))
	}
	if count != len(content) {
		return server.writeStatus(id, sftpStatusFailure, "Short SFTP write.")
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) decodeTransfer(decoder *shellSFTPDecoder) (*shellSFTPHandle, uint64, uint32, error) {
	handleName, err := decoder.string(128)
	if err != nil {
		return nil, 0, 0, &shellSFTPError{code: sftpStatusBadMessage, message: "Invalid SFTP request."}
	}
	offset, err := decoder.uint64()
	if err != nil {
		return nil, 0, 0, &shellSFTPError{code: sftpStatusBadMessage, message: "Invalid SFTP request."}
	}
	length, err := decoder.uint32()
	if err != nil || decoder.remaining() != 0 || offset > math.MaxInt64 {
		return nil, 0, 0, &shellSFTPError{code: sftpStatusBadMessage, message: "Invalid SFTP request."}
	}
	handle, ok := server.handles[handleName]
	if !ok {
		return nil, 0, 0, &shellSFTPError{code: sftpStatusFailure, message: "Invalid SFTP handle."}
	}
	return handle, offset, length, nil
}

func (server *shellSFTPServer) stat(id uint32, decoder *shellSFTPDecoder, follow bool) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, synthetic, err := server.namespacePath(requested)
	if err != nil {
		return server.writeError(id, err)
	}
	if synthetic {
		return server.writeAttrs(id, syntheticShellFileInfo{name: path.Base(namespace)})
	}
	resolved, err := resolveShellSharePath(share, relative, follow, false)
	if err != nil {
		return server.writeError(id, err)
	}
	var info os.FileInfo
	if follow {
		info, err = share.root.Stat(resolved)
	} else {
		info, err = share.root.Lstat(resolved)
	}
	if err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	return server.writeAttrs(id, info)
}

func (server *shellSFTPServer) fstat(id uint32, decoder *shellSFTPDecoder) error {
	handleName, err := decoder.string(128)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	handle, ok := server.handles[handleName]
	if !ok || handle.file == nil {
		return server.writeStatus(id, sftpStatusFailure, "Invalid SFTP handle.")
	}
	info, err := handle.file.Stat()
	if err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	return server.writeAttrs(id, info)
}

func (server *shellSFTPServer) setstat(id uint32, decoder *shellSFTPDecoder, _ bool) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil {
		return server.badMessage(id)
	}
	attrs, err := decoder.attrs()
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, err := server.sharedPath(requested, true)
	if err != nil {
		return server.writeError(id, err)
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.mutate", "channel": server.channel, "op": "setstat", "path": namespace})
	resolved, err := resolveShellSharePath(share, relative, true, false)
	if err != nil {
		return server.writeError(id, err)
	}
	openFlags := unix.O_RDONLY | unix.O_NONBLOCK | unix.O_NOFOLLOW
	if attrs.flags&sftpAttrSize != 0 {
		openFlags = unix.O_RDWR | unix.O_NONBLOCK | unix.O_NOFOLLOW
	}
	file, err := share.root.OpenFile(resolved, openFlags, 0)
	if err != nil && attrs.flags&sftpAttrSize != 0 && errors.Is(err, unix.EISDIR) {
		file, err = share.root.OpenFile(resolved, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
	}
	if err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	defer file.Close()
	if err := applyShellAttrs(file, attrs); err != nil {
		return server.writeError(id, err)
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) fsetstat(id uint32, decoder *shellSFTPDecoder) error {
	handleName, err := decoder.string(128)
	if err != nil {
		return server.badMessage(id)
	}
	attrs, err := decoder.attrs()
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	handle, ok := server.handles[handleName]
	if !ok || handle.file == nil || handle.share.mode != "read-write" {
		return server.permission(id, "SFTP handle is not open for metadata changes.")
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.mutate", "channel": server.channel, "op": "setstat", "path": handle.namespacePath})
	if err := applyShellAttrs(handle.file, attrs); err != nil {
		return server.writeError(id, err)
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func applyShellAttrs(file *os.File, attrs shellSFTPAttrs) error {
	if attrs.flags&(sftpAttrUIDGID|sftpAttrExtended) != 0 {
		return &shellSFTPError{code: sftpStatusOpUnsupported, message: "Only size, permissions, and times may be changed."}
	}
	info, err := file.Stat()
	if err != nil {
		return shellErrorFromOS(err)
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return &shellSFTPError{code: sftpStatusPermissionDenied, message: "Opensteer only changes metadata for regular files and directories over SFTP."}
	}
	if info.IsDir() && attrs.flags&sftpAttrSize != 0 {
		return &shellSFTPError{code: sftpStatusFailure, message: "SFTP cannot change the size of a directory."}
	}
	if attrs.flags&sftpAttrSize != 0 {
		if attrs.value.Size > math.MaxInt64 {
			return &shellSFTPError{code: sftpStatusFailure, message: "Requested file size is too large."}
		}
		if err := file.Truncate(int64(attrs.value.Size)); err != nil {
			return shellErrorFromOS(err)
		}
	}
	if attrs.flags&sftpAttrPermissions != 0 {
		if err := file.Chmod(os.FileMode(attrs.value.Mode & 0777)); err != nil {
			return shellErrorFromOS(err)
		}
	}
	if attrs.flags&sftpAttrTimes != 0 {
		times := []unix.Timeval{unix.NsecToTimeval(int64(attrs.value.Atime) * int64(time.Second)), unix.NsecToTimeval(int64(attrs.value.Mtime) * int64(time.Second))}
		if err := unix.Futimes(int(file.Fd()), times); err != nil {
			return shellErrorFromOS(err)
		}
	}
	return nil
}

func (server *shellSFTPServer) opendir(id uint32, decoder *shellSFTPDecoder) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, synthetic, err := server.namespacePath(requested)
	if err != nil {
		return server.writeError(id, err)
	}
	handle := &shellSFTPHandle{namespacePath: namespace, share: share}
	if synthetic {
		handle.directoryEntries = server.syntheticEntries(namespace)
	} else {
		resolved, resolveErr := resolveShellSharePath(share, relative, true, false)
		if resolveErr != nil {
			return server.writeError(id, resolveErr)
		}
		file, openErr := share.root.OpenFile(resolved, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
		if openErr != nil {
			return server.writeError(id, shellErrorFromOS(openErr))
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.IsDir() {
			_ = file.Close()
			if statErr != nil {
				return server.writeError(id, shellErrorFromOS(statErr))
			}
			return server.writeStatus(id, sftpStatusNoSuchFile, "Not a directory.")
		}
		entries, readErr := file.ReadDir(-1)
		if readErr != nil {
			_ = file.Close()
			return server.writeError(id, shellErrorFromOS(readErr))
		}
		handle.file = file
		handle.directoryEntries = make([]os.FileInfo, 0, len(entries))
		for _, entry := range entries {
			entryInfo, infoErr := entry.Info()
			if infoErr == nil {
				handle.directoryEntries = append(handle.directoryEntries, entryInfo)
			}
		}
		sort.Slice(handle.directoryEntries, func(left, right int) bool {
			return handle.directoryEntries[left].Name() < handle.directoryEntries[right].Name()
		})
	}
	return server.writeHandle(id, server.newHandle(handle))
}

func (server *shellSFTPServer) readdir(id uint32, decoder *shellSFTPDecoder) error {
	handleName, err := decoder.string(128)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	handle, ok := server.handles[handleName]
	if !ok || handle.directoryEntries == nil {
		return server.writeStatus(id, sftpStatusFailure, "Invalid SFTP directory handle.")
	}
	if handle.directoryOffset >= len(handle.directoryEntries) {
		return server.writeStatus(id, sftpStatusEOF, "End of directory")
	}
	end := handle.directoryOffset + 64
	if end > len(handle.directoryEntries) {
		end = len(handle.directoryEntries)
	}
	entries := handle.directoryEntries[handle.directoryOffset:end]
	handle.directoryOffset = end
	return server.writeNames(id, entries, "")
}

func (server *shellSFTPServer) mkdir(id uint32, decoder *shellSFTPDecoder) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil {
		return server.badMessage(id)
	}
	attrs, err := decoder.attrs()
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, err := server.sharedPath(requested, true)
	if err != nil {
		return server.writeError(id, err)
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.mutate", "channel": server.channel, "op": "mkdir", "path": namespace})
	resolved, err := resolveShellSharePath(share, relative, false, true)
	if err != nil {
		return server.writeError(id, err)
	}
	mode := os.FileMode(0755)
	if attrs.flags&sftpAttrPermissions != 0 {
		mode = os.FileMode(attrs.value.Mode & 0777)
	}
	if attrs.flags&(sftpAttrUIDGID|sftpAttrExtended|sftpAttrSize|sftpAttrTimes) != 0 {
		return server.writeStatus(id, sftpStatusOpUnsupported, "Unsupported directory attributes.")
	}
	if err := share.root.Mkdir(resolved, mode); err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) remove(id uint32, decoder *shellSFTPDecoder, directory bool) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, err := server.sharedPath(requested, true)
	if err != nil {
		return server.writeError(id, err)
	}
	if relative == "." {
		return server.permission(id, "A shared folder root cannot be removed.")
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.mutate", "channel": server.channel, "op": "remove", "path": namespace})
	resolved, err := resolveShellSharePath(share, relative, false, false)
	if err != nil {
		return server.writeError(id, err)
	}
	info, err := share.root.Lstat(resolved)
	if err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	if directory != info.IsDir() {
		return server.writeStatus(id, sftpStatusFailure, "SFTP remove type does not match the path.")
	}
	if err := share.root.Remove(resolved); err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) rename(id uint32, decoder *shellSFTPDecoder, overwrite bool) error {
	oldRequested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil {
		return server.badMessage(id)
	}
	newRequested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	oldNamespace, oldShare, oldRelative, err := server.sharedPath(oldRequested, true)
	if err != nil {
		return server.writeError(id, err)
	}
	newNamespace, newShare, newRelative, err := server.sharedPath(newRequested, true)
	if err != nil {
		return server.writeError(id, err)
	}
	if oldShare != newShare || oldRelative == "." || newRelative == "." {
		return server.permission(id, "SFTP rename must stay within one writable share and cannot rename its root.")
	}
	server.session.emitter.audit(map[string]any{"kind": "sftp.mutate", "channel": server.channel, "op": "rename", "path": oldNamespace, "target": newNamespace})
	oldResolved, err := resolveShellSharePath(oldShare, oldRelative, false, false)
	if err != nil {
		return server.writeError(id, err)
	}
	newResolved, err := resolveShellSharePath(newShare, newRelative, false, true)
	if err != nil {
		return server.writeError(id, err)
	}
	if !overwrite {
		if _, statErr := newShare.root.Lstat(newResolved); statErr == nil {
			return server.writeStatus(id, sftpStatusFailure, "Rename target already exists.")
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return server.writeError(id, shellErrorFromOS(statErr))
		}
	}
	if err := oldShare.root.Rename(oldResolved, newResolved); err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	return server.writeStatus(id, sftpStatusOK, "")
}

func (server *shellSFTPServer) realpath(id uint32, decoder *shellSFTPDecoder) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	namespace, share, relative, synthetic, err := server.namespacePath(requested)
	if err != nil {
		return server.writeError(id, err)
	}
	if !synthetic {
		resolved, resolveErr := resolveShellSharePath(share, relative, true, false)
		if resolveErr != nil {
			return server.writeError(id, resolveErr)
		}
		namespace = share.path
		if resolved != "." {
			namespace = path.Join(namespace, resolved)
		}
	}
	return server.writeNames(id, []os.FileInfo{syntheticShellFileInfo{name: path.Base(namespace)}}, namespace)
}

func (server *shellSFTPServer) readlink(id uint32, decoder *shellSFTPDecoder) error {
	requested, err := decoder.string(maxSFTPPacketBytes)
	if err != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	_, share, relative, err := server.sharedPath(requested, false)
	if err != nil {
		return server.writeError(id, err)
	}
	resolved, err := resolveShellSharePath(share, relative, false, false)
	if err != nil {
		return server.writeError(id, err)
	}
	target, err := share.root.Readlink(resolved)
	if err != nil {
		return server.writeError(id, shellErrorFromOS(err))
	}
	if path.IsAbs(target) || escapesShellRoot(path.Join(path.Dir(resolved), target)) {
		return server.permission(id, "Absolute or escaping symbolic links are not shared.")
	}
	return server.writeNames(id, []os.FileInfo{syntheticShellFileInfo{name: target}}, target)
}

func (server *shellSFTPServer) refuseLink(id uint32, decoder *shellSFTPDecoder, kind string) error {
	_, firstErr := decoder.string(maxSFTPPacketBytes)
	_, secondErr := decoder.string(maxSFTPPacketBytes)
	if firstErr != nil || secondErr != nil || decoder.remaining() != 0 {
		return server.badMessage(id)
	}
	return server.permission(id, fmt.Sprintf("SFTP %s creation is not allowed.", kind))
}

func (server *shellSFTPServer) extended(id uint32, decoder *shellSFTPDecoder) error {
	name, err := decoder.string(256)
	if err != nil {
		return server.badMessage(id)
	}
	switch name {
	case "posix-rename@openssh.com":
		return server.rename(id, decoder, true)
	case "expand-path@openssh.com":
		return server.realpath(id, decoder)
	case "fsync@openssh.com":
		handleName, handleErr := decoder.string(128)
		if handleErr != nil || decoder.remaining() != 0 {
			return server.badMessage(id)
		}
		handle, ok := server.handles[handleName]
		if !ok || handle.file == nil {
			return server.writeStatus(id, sftpStatusFailure, "Invalid SFTP handle.")
		}
		if err := handle.file.Sync(); err != nil {
			return server.writeError(id, shellErrorFromOS(err))
		}
		return server.writeStatus(id, sftpStatusOK, "")
	case "hardlink@openssh.com":
		return server.refuseLink(id, decoder, "hard-link")
	default:
		server.session.denied(&server.channel, "sftp", shortenShellDetail("Unsupported extension: "+name))
		return server.writeStatus(id, sftpStatusOpUnsupported, "SFTP extension is unsupported.")
	}
}

func (server *shellSFTPServer) namespacePath(requested string) (string, *shellShare, string, bool, error) {
	namespace, err := normalizeShellNamespace(requested, server.session.home)
	if err != nil {
		server.session.denied(&server.channel, "sftp", err.Error())
		return "", nil, "", false, err
	}
	for _, share := range server.session.shares {
		if shellPathWithin(namespace, share.path) {
			if share.errorCode != 0 {
				if share.errorCode == sftpStatusPermissionDenied {
					server.session.denied(&server.channel, "sftp", share.errorText)
				}
				return "", nil, "", false, &shellSFTPError{code: share.errorCode, denied: share.errorCode == sftpStatusPermissionDenied, message: share.errorText}
			}
			relative := strings.TrimPrefix(namespace, share.path)
			relative = strings.TrimPrefix(relative, "/")
			if relative == "" {
				relative = "."
			}
			return namespace, share, relative, false, nil
		}
	}
	if server.isSynthetic(namespace) {
		return namespace, nil, "", true, nil
	}
	message := server.notSharedMessage()
	server.session.denied(&server.channel, "sftp", message)
	return "", nil, "", false, &shellSFTPError{code: sftpStatusPermissionDenied, denied: true, message: message}
}

func (server *shellSFTPServer) sharedPath(requested string, mutate bool) (string, *shellShare, string, error) {
	namespace, share, relative, synthetic, err := server.namespacePath(requested)
	if err != nil {
		return "", nil, "", err
	}
	if synthetic || share == nil {
		return "", nil, "", server.denialError("Only shared folders can be changed. " + server.shareDescription())
	}
	if mutate && share.mode != "read-write" {
		return "", nil, "", server.denialError(fmt.Sprintf("Shared folder %s is read-only.", share.path))
	}
	return namespace, share, relative, nil
}

func normalizeShellNamespace(requested, home string) (string, error) {
	if requested == "" || strings.ContainsRune(requested, 0) || !utf8.ValidString(requested) || len(requested) > maxShellPathBytes {
		return "", &shellSFTPError{code: sftpStatusBadMessage, message: "Invalid SFTP path."}
	}
	switch {
	case requested == "~":
		requested = home
	case strings.HasPrefix(requested, "~/"):
		requested = path.Join(home, strings.TrimPrefix(requested, "~/"))
	case strings.HasPrefix(requested, "~"):
		return "", &shellSFTPError{code: sftpStatusPermissionDenied, denied: true, message: "SFTP ~user paths are not supported."}
	case !path.IsAbs(requested):
		requested = path.Join(home, requested)
	}
	cleaned := path.Clean(requested)
	// OpenSSH's sftp joins its remote working directory onto "~/…" before
	// sending, so "<home>/~/x" is how "~/x" arrives from a real client. That
	// component resolves to home; a directory literally named "~" directly under
	// home is therefore unreachable over SFTP, which the spec states.
	if cleaned == path.Join(home, "~") {
		return home, nil
	}
	if prefix := path.Join(home, "~") + "/"; strings.HasPrefix(cleaned, prefix) {
		return path.Clean(path.Join(home, strings.TrimPrefix(cleaned, prefix))), nil
	}
	return cleaned, nil
}

func (server *shellSFTPServer) isSynthetic(namespace string) bool {
	if namespace == "/" || namespace == server.session.home {
		return true
	}
	branches := []string{server.session.home}
	for _, share := range server.session.shares {
		branches = append(branches, share.path)
	}
	for _, branch := range branches {
		if namespace != branch && shellPathWithin(branch, namespace) {
			return true
		}
	}
	return false
}

func (server *shellSFTPServer) syntheticEntries(namespace string) []os.FileInfo {
	children := make(map[string]struct{})
	branches := []string{server.session.home}
	for _, share := range server.session.shares {
		branches = append(branches, share.path)
	}
	for _, branch := range branches {
		if branch == namespace || !shellPathWithin(branch, namespace) {
			continue
		}
		remainder := strings.TrimPrefix(branch, namespace)
		remainder = strings.TrimPrefix(remainder, "/")
		if remainder == "" {
			continue
		}
		children[strings.SplitN(remainder, "/", 2)[0]] = struct{}{}
	}
	names := make([]string, 0, len(children))
	for name := range children {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]os.FileInfo, 0, len(names))
	for _, name := range names {
		entries = append(entries, syntheticShellFileInfo{name: name})
	}
	return entries
}

func (server *shellSFTPServer) notSharedMessage() string {
	return "Not shared. " + server.shareDescription()
}

func (server *shellSFTPServer) shareDescription() string {
	if len(server.session.shares) == 0 {
		return fmt.Sprintf("%s shares no folders.", server.session.machine)
	}
	items := make([]string, 0, len(server.session.shares))
	for _, share := range server.session.shares {
		mode := "read-only"
		if share.mode == "read-write" {
			mode = "read-write"
		}
		items = append(items, fmt.Sprintf("%s (%s)", share.path, mode))
	}
	return fmt.Sprintf("%s shares: %s.", server.session.machine, strings.Join(items, ", "))
}

func resolveShellSharePath(share *shellShare, relative string, followFinal, allowMissingFinal bool) (string, error) {
	cleaned := path.Clean(relative)
	if escapesShellRoot(cleaned) || path.IsAbs(cleaned) {
		return "", &shellSFTPError{code: sftpStatusPermissionDenied, message: "Path escapes its shared folder."}
	}
	if cleaned == "." {
		return cleaned, nil
	}
	components := strings.Split(cleaned, "/")
	resolved := make([]string, 0, len(components))
	for links := 0; len(components) > 0; {
		component := components[0]
		components = components[1:]
		candidate := path.Join(append(resolved, component)...)
		info, err := share.root.Lstat(candidate)
		if err != nil {
			if allowMissingFinal && len(components) == 0 && errors.Is(err, fs.ErrNotExist) {
				return candidate, nil
			}
			return "", shellErrorFromOS(err)
		}
		isFinal := len(components) == 0
		if info.Mode()&os.ModeSymlink != 0 && (followFinal || !isFinal) {
			links++
			if links > 40 {
				return "", &shellSFTPError{code: sftpStatusFailure, message: "Too many symbolic links."}
			}
			target, err := share.root.Readlink(candidate)
			if err != nil {
				return "", shellErrorFromOS(err)
			}
			if path.IsAbs(target) {
				return "", &shellSFTPError{code: sftpStatusPermissionDenied, message: "Absolute symbolic links are not shared."}
			}
			combined := path.Join(append(resolved, target)...)
			if escapesShellRoot(combined) {
				return "", &shellSFTPError{code: sftpStatusPermissionDenied, message: "Symbolic link escapes its shared folder."}
			}
			components = append(strings.Split(combined, "/"), components...)
			resolved = resolved[:0]
			continue
		}
		resolved = append(resolved, component)
	}
	return path.Join(resolved...), nil
}

func escapesShellRoot(value string) bool {
	cleaned := path.Clean(value)
	return cleaned == ".." || strings.HasPrefix(cleaned, "../")
}

func shellErrorFromOS(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, unix.ENOTDIR) {
		return &shellSFTPError{code: sftpStatusNoSuchFile, message: "No such file or directory."}
	}
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) || errors.Is(err, unix.EXDEV) || errors.Is(err, unix.ELOOP) {
		return &shellSFTPError{code: sftpStatusPermissionDenied, message: "Permission denied."}
	}
	return &shellSFTPError{code: sftpStatusFailure, message: shortenShellDetail(err.Error())}
}

func (server *shellSFTPServer) denialError(message string) error {
	server.session.denied(&server.channel, "sftp", message)
	return &shellSFTPError{code: sftpStatusPermissionDenied, denied: true, message: message}
}

func (server *shellSFTPServer) permission(id uint32, message string) error {
	return server.writeError(id, server.denialError(message))
}

func (server *shellSFTPServer) badMessage(id uint32) error {
	return server.writeStatus(id, sftpStatusBadMessage, "Invalid SFTP request.")
}

func (server *shellSFTPServer) newHandle(handle *shellSFTPHandle) string {
	server.nextHandle++
	name := fmt.Sprintf("h%d", server.nextHandle)
	server.handles[name] = handle
	return name
}

func (server *shellSFTPServer) closeHandles() {
	for name, handle := range server.handles {
		if handle.file != nil {
			_ = handle.file.Close()
		}
		delete(server.handles, name)
	}
}

func (server *shellSFTPServer) readPacket() (byte, []byte, error) {
	var lengthBytes [4]byte
	if _, err := io.ReadFull(server.reader, lengthBytes[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(lengthBytes[:])
	if length < 1 || length > maxSFTPPacketBytes {
		return 0, nil, errors.New("invalid SFTP packet length")
	}
	content := make([]byte, length)
	if _, err := io.ReadFull(server.reader, content); err != nil {
		return 0, nil, err
	}
	return content[0], content[1:], nil
}

func (server *shellSFTPServer) writePacket(packetType byte, payload []byte) error {
	if len(payload)+1 > maxSFTPPacketBytes {
		return errors.New("SFTP response exceeds packet limit")
	}
	content := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(content[:4], uint32(len(payload)+1))
	content[4] = packetType
	copy(content[5:], payload)
	_, err := server.writer.Write(content)
	return err
}

func (server *shellSFTPServer) writeStatus(id, code uint32, message string) error {
	response := &shellSFTPEncoder{}
	response.uint32(id)
	response.uint32(code)
	response.string(message)
	response.string("")
	return server.writePacket(sftpPacketStatus, response.bytes())
}

func (server *shellSFTPServer) writeError(id uint32, err error) error {
	var protocolError *shellSFTPError
	if errors.As(err, &protocolError) {
		if protocolError.code == sftpStatusPermissionDenied && !protocolError.denied {
			server.session.denied(&server.channel, "sftp", protocolError.message)
		}
		return server.writeStatus(id, protocolError.code, protocolError.message)
	}
	return server.writeStatus(id, sftpStatusFailure, shortenShellDetail(err.Error()))
}

func (server *shellSFTPServer) writeHandle(id uint32, handle string) error {
	response := &shellSFTPEncoder{}
	response.uint32(id)
	response.string(handle)
	return server.writePacket(sftpPacketHandle, response.bytes())
}

func (server *shellSFTPServer) writeAttrs(id uint32, info os.FileInfo) error {
	response := &shellSFTPEncoder{}
	response.uint32(id)
	response.fileInfo(info)
	return server.writePacket(sftpPacketAttrs, response.bytes())
}

func (server *shellSFTPServer) writeNames(id uint32, entries []os.FileInfo, forcedName string) error {
	response := &shellSFTPEncoder{}
	response.uint32(id)
	response.uint32(uint32(len(entries)))
	for _, entry := range entries {
		name := entry.Name()
		if forcedName != "" {
			name = forcedName
		}
		response.string(name)
		response.string(name)
		response.fileInfo(entry)
	}
	return server.writePacket(sftpPacketName, response.bytes())
}

type shellSFTPDecoder struct {
	content []byte
	offset  int
}

func (decoder *shellSFTPDecoder) remaining() int { return len(decoder.content) - decoder.offset }

func (decoder *shellSFTPDecoder) uint32() (uint32, error) {
	if decoder.remaining() < 4 {
		return 0, io.ErrUnexpectedEOF
	}
	value := binary.BigEndian.Uint32(decoder.content[decoder.offset : decoder.offset+4])
	decoder.offset += 4
	return value, nil
}

func (decoder *shellSFTPDecoder) uint64() (uint64, error) {
	if decoder.remaining() < 8 {
		return 0, io.ErrUnexpectedEOF
	}
	value := binary.BigEndian.Uint64(decoder.content[decoder.offset : decoder.offset+8])
	decoder.offset += 8
	return value, nil
}

func (decoder *shellSFTPDecoder) rawString(limit int) ([]byte, error) {
	length, err := decoder.uint32()
	if err != nil || length > uint32(limit) || uint64(length) > uint64(decoder.remaining()) {
		return nil, io.ErrUnexpectedEOF
	}
	value := decoder.content[decoder.offset : decoder.offset+int(length)]
	decoder.offset += int(length)
	return value, nil
}

func (decoder *shellSFTPDecoder) string(limit int) (string, error) {
	value, err := decoder.rawString(limit)
	if err != nil || !utf8.Valid(value) {
		return "", io.ErrUnexpectedEOF
	}
	return string(value), nil
}

type shellSFTPAttrs struct {
	flags uint32
	value shellSFTPFileStat
}

type shellSFTPFileStat struct {
	Size  uint64
	UID   uint32
	GID   uint32
	Mode  uint32
	Atime uint32
	Mtime uint32
}

func (decoder *shellSFTPDecoder) attrs() (shellSFTPAttrs, error) {
	flags, err := decoder.uint32()
	if err != nil {
		return shellSFTPAttrs{}, err
	}
	attrs := shellSFTPAttrs{flags: flags}
	if flags&sftpAttrSize != 0 {
		attrs.value.Size, err = decoder.uint64()
	}
	if err == nil && flags&sftpAttrUIDGID != 0 {
		attrs.value.UID, err = decoder.uint32()
		if err == nil {
			attrs.value.GID, err = decoder.uint32()
		}
	}
	if err == nil && flags&sftpAttrPermissions != 0 {
		attrs.value.Mode, err = decoder.uint32()
	}
	if err == nil && flags&sftpAttrTimes != 0 {
		attrs.value.Atime, err = decoder.uint32()
		if err == nil {
			attrs.value.Mtime, err = decoder.uint32()
		}
	}
	if err == nil && flags&sftpAttrExtended != 0 {
		var count uint32
		count, err = decoder.uint32()
		if count > 128 {
			err = io.ErrUnexpectedEOF
		}
		for index := uint32(0); err == nil && index < count; index++ {
			_, err = decoder.rawString(maxSFTPPacketBytes)
			if err == nil {
				_, err = decoder.rawString(maxSFTPPacketBytes)
			}
		}
	}
	return attrs, err
}

type shellSFTPEncoder struct {
	buffer bytes.Buffer
}

func (encoder *shellSFTPEncoder) bytes() []byte { return encoder.buffer.Bytes() }
func (encoder *shellSFTPEncoder) uint32(value uint32) {
	var content [4]byte
	binary.BigEndian.PutUint32(content[:], value)
	encoder.buffer.Write(content[:])
}
func (encoder *shellSFTPEncoder) uint64(value uint64) {
	var content [8]byte
	binary.BigEndian.PutUint64(content[:], value)
	encoder.buffer.Write(content[:])
}
func (encoder *shellSFTPEncoder) string(value string) { encoder.rawString([]byte(value)) }
func (encoder *shellSFTPEncoder) rawString(value []byte) {
	encoder.uint32(uint32(len(value)))
	encoder.buffer.Write(value)
}
func (encoder *shellSFTPEncoder) fileInfo(info os.FileInfo) {
	encoder.uint32(sftpAttrSize | sftpAttrPermissions | sftpAttrTimes)
	size := info.Size()
	if size < 0 {
		size = 0
	}
	encoder.uint64(uint64(size))
	encoder.uint32(shellSFTPMode(info.Mode()))
	seconds := info.ModTime().Unix()
	if seconds < 0 {
		seconds = 0
	}
	if seconds > math.MaxUint32 {
		seconds = math.MaxUint32
	}
	encoder.uint32(uint32(seconds))
	encoder.uint32(uint32(seconds))
}

func shellSFTPMode(mode os.FileMode) uint32 {
	value := uint32(mode.Perm())
	switch {
	case mode.IsRegular():
		value |= 0100000
	case mode.IsDir():
		value |= 0040000
	case mode&os.ModeSymlink != 0:
		value |= 0120000
	case mode&os.ModeNamedPipe != 0:
		value |= 0010000
	case mode&os.ModeSocket != 0:
		value |= 0140000
	case mode&os.ModeDevice != 0 && mode&os.ModeCharDevice != 0:
		value |= 0020000
	case mode&os.ModeDevice != 0:
		value |= 0060000
	}
	return value
}

type syntheticShellFileInfo struct{ name string }

func (info syntheticShellFileInfo) Name() string  { return info.name }
func (syntheticShellFileInfo) Size() int64        { return 0 }
func (syntheticShellFileInfo) Mode() os.FileMode  { return os.ModeDir | 0555 }
func (syntheticShellFileInfo) ModTime() time.Time { return time.Unix(0, 0) }
func (syntheticShellFileInfo) IsDir() bool        { return true }
func (syntheticShellFileInfo) Sys() any           { return nil }
