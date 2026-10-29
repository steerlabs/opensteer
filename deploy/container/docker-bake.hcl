// Bake definition for the hosted-image build. One invocation builds every
// deployable target from Containerfile; BuildKit deduplicates the shared
// dependency stages across targets automatically.
//
// CI publishes one immutable sha-<sourceRevision> tag per component. Production
// receives promoted digests only and never builds or follows a mutable tag.
// Supply REGISTRY and TAG explicitly for the destination of this build.

variable "REGISTRY" {
  default = "opensteer"
}

variable "TAG" {
  default = "local"
}

variable "RUNNER_ARTIFACT_BASE_URL" {
  default = ""
}

variable "RELEASE_VERSION" {
  default = ""
}

variable "SOURCE_URL" {
  default = ""
}

variable "SOURCE_REVISION" {
  default = ""
}

variable "RUNNER_SOURCE_REVISION" {
  default = ""
}

variable "SOURCE_DATE_EPOCH" {
  default = ""
}

variable "AGENT_PHONE_RECEIPT_SHA256" {
  default = ""
}

variable "CACHE_BACKEND" {
  default = "gha"
}

// Mutable cache repository, provisioned separately from staging.
variable "CACHE_REGISTRY" {
  default = ""
}

variable "CACHE_SCOPE" {
  default = "linux-amd64-v1"
}

function "cache_from" {
  params = [name]
  result = CACHE_BACKEND == "gha" ? ["type=gha,scope=${name}-${CACHE_SCOPE}"] : (CACHE_REGISTRY != "" ? ["type=registry,ref=${CACHE_REGISTRY}/${name}:${CACHE_SCOPE}"] : [])
}

variable "CACHE_EXPORT" {
  default = "true"
}

function "cache_to" {
  params = [name]
  result = CACHE_EXPORT == "false" ? [] : (CACHE_BACKEND == "gha" ? ["type=gha,scope=${name}-${CACHE_SCOPE},mode=max"] : (CACHE_REGISTRY != "" ? ["type=registry,ref=${CACHE_REGISTRY}/${name}:${CACHE_SCOPE},mode=max,image-manifest=true,oci-mediatypes=true"] : []))
}

// Callers may supply a registry mirror for Docker Hub base images. Digests
// stay identical to the Containerfile defaults when using a mirror.
variable "DOCKERHUB_MIRROR" {
  default = "docker.io"
}

group "default" {
  targets = [
    "host",
    "control-plane",
    "runner",
    "browser-runtime",
    "browser-egress",
    "browser-profile-gateway",
    "channel-runtime",
    "gateway",
  ]
}

target "_common" {
  context    = "."
  dockerfile = "deploy/container/Containerfile"
  platforms  = ["linux/amd64"]
  attest     = ["type=provenance,disabled=true"]
  args = {
    NODE_IMAGE  = "${DOCKERHUB_MIRROR}/library/node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f"
    GO_IMAGE    = "${DOCKERHUB_MIRROR}/library/golang:1.26.2-bookworm@sha256:47ce5636e9936b2c5cbf708925578ef386b4f8872aec74a67bd13a627d242b19"
    CADDY_IMAGE = "${DOCKERHUB_MIRROR}/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
    OPENSTEER_IMAGE_REGISTRY = REGISTRY
    OPENSTEER_RUNNER_ARTIFACT_BASE_URL = RUNNER_ARTIFACT_BASE_URL
    OPENSTEER_RELEASE_VERSION = "${RELEASE_VERSION}"
    OPENSTEER_SOURCE_REVISION = "${SOURCE_REVISION}"
    OPENSTEER_RUNNER_SOURCE_REVISION = RUNNER_SOURCE_REVISION != "" ? RUNNER_SOURCE_REVISION : SOURCE_REVISION
    OPENSTEER_AGENT_PHONE_MODE = "official"
    OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256 = "${AGENT_PHONE_RECEIPT_SHA256}"
  }
  labels = {
    "org.opencontainers.image.revision" = "${SOURCE_REVISION}"
    "org.opencontainers.image.source"   = "${SOURCE_URL}"
    "org.opencontainers.image.version"  = "${RELEASE_VERSION}"
  }
}

target "host" {
  inherits   = ["_common"]
  target     = "host"
  tags       = ["${REGISTRY}/host:${TAG}"]
  cache-from = cache_from("host")
  cache-to   = cache_to("host")
}

target "control-plane" {
  inherits   = ["_common"]
  target     = "control-plane"
  tags       = ["${REGISTRY}/control-plane:${TAG}"]
  cache-from = cache_from("control-plane")
  cache-to   = cache_to("control-plane")
}

target "runner" {
  inherits   = ["_common"]
  target     = "runner"
  tags       = ["${REGISTRY}/runner:${TAG}"]
  cache-from = cache_from("runner")
  cache-to   = cache_to("runner")
}

target "browser-runtime" {
  inherits   = ["_common"]
  target     = "browser-runtime"
  tags       = ["${REGISTRY}/browser-runtime:${TAG}"]
  cache-from = cache_from("browser-runtime")
  cache-to   = cache_to("browser-runtime")
}

target "browser-egress" {
  inherits   = ["_common"]
  target     = "browser-egress"
  tags       = ["${REGISTRY}/browser-egress:${TAG}"]
  cache-from = cache_from("browser-egress")
  cache-to   = cache_to("browser-egress")
}

target "browser-profile-gateway" {
  inherits   = ["_common"]
  target     = "browser-profile-gateway"
  tags       = ["${REGISTRY}/browser-profile-gateway:${TAG}"]
  cache-from = cache_from("browser-profile-gateway")
  cache-to   = cache_to("browser-profile-gateway")
}

target "channel-runtime" {
  inherits   = ["_common"]
  target     = "channel-runtime"
  tags       = ["${REGISTRY}/channel-runtime:${TAG}"]
  cache-from = cache_from("channel-runtime")
  cache-to   = cache_to("channel-runtime")
}

target "gateway" {
  inherits   = ["_common"]
  target     = "gateway"
  tags       = ["${REGISTRY}/gateway:${TAG}"]
  cache-from = cache_from("gateway")
  cache-to   = cache_to("gateway")
}
