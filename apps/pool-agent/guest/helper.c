// The guest half of the pool agent's control channel, on vsock port 1024.
// One command per connection from the host (CID 2): 'P' ping, 'S' sync the
// filesystems, 'T' + two little-endian int64 (seconds, nanoseconds) set the
// wall clock. The answer is the single byte 'K'. It reads nothing else and
// sends nothing else, so the host never parses guest data.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <linux/vm_sockets.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static int read_full(int fd, unsigned char *buffer, size_t length) {
  size_t done = 0;
  while (done < length) {
    ssize_t n = read(fd, buffer + done, length - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    done += (size_t)n;
  }
  return 0;
}

static int64_t le64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (int i = 7; i >= 0; i--) value = (value << 8) | bytes[i];
  return (int64_t)value;
}

/*
 * The instance's bridge token (pool-runtime-in-guest.md, decision 3): written to tmpfs for the
 * runtime's user alone, replaced atomically. The same token after a restore rewrites the same
 * file. It is never echoed back: the answer is the one fixed byte.
 */
static int store_token(const unsigned char *token) {
  char hex[65];
  for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", token[i]);
  mkdir("/run/secrets", 0711);
  int fd = open("/run/secrets/.browser_token", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0400);
  if (fd < 0) return -1;
  int ok = write(fd, hex, 64) == 64 && fchown(fd, 10001, 10001) == 0 && fchmod(fd, 0400) == 0;
  if (close(fd) != 0) ok = 0;
  if (!ok) return -1;
  return rename("/run/secrets/.browser_token", "/run/secrets/browser_token");
}

static void serve(int client) {
  struct timeval limit = {.tv_sec = 2, .tv_usec = 0};
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &limit, sizeof limit);
  unsigned char command;
  if (read_full(client, &command, 1) != 0) return;
  int ok = 0;
  if (command == 'P') {
    ok = 1;
  } else if (command == 'S') {
    sync();
    ok = 1;
  } else if (command == 'B') {
    unsigned char token[32];
    if (read_full(client, token, sizeof token) != 0) return;
    ok = store_token(token) == 0;
    memset(token, 0, sizeof token);
  } else if (command == 'T') {
    unsigned char payload[16];
    if (read_full(client, payload, sizeof payload) != 0) return;
    struct timespec now = {.tv_sec = (time_t)le64(payload), .tv_nsec = (long)le64(payload + 8)};
    if (now.tv_sec > 1700000000 && now.tv_nsec >= 0 && now.tv_nsec < 1000000000)
      ok = clock_settime(CLOCK_REALTIME, &now) == 0;
  }
  if (ok) {
    const char answer = 'K';
    (void)!write(client, &answer, 1);
  }
}

int main(void) {
  int listener = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) return 1;
  struct sockaddr_vm address;
  memset(&address, 0, sizeof address);
  address.svm_family = AF_VSOCK;
  address.svm_cid = VMADDR_CID_ANY;
  address.svm_port = 1024;
  if (bind(listener, (struct sockaddr *)&address, sizeof address) != 0) return 1;
  if (listen(listener, 4) != 0) return 1;
  for (;;) {
    struct sockaddr_vm peer;
    socklen_t size = sizeof peer;
    int client = accept4(listener, (struct sockaddr *)&peer, &size, SOCK_CLOEXEC);
    if (client < 0) {
      if (errno == EINTR) continue;
      usleep(10000);
      continue;
    }
    // Only the host may command the guest.
    if (peer.svm_cid == VMADDR_CID_HOST) serve(client);
    close(client);
  }
}
