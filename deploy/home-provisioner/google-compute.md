# Google Compute Engine for Opensteer Cloud Computers

Use a dedicated Compute project and VPC. A provisioner deployment manages one
Compute zone.

Keep the configured zone fixed while the project has managed VMs. Every pass
also lists the project's instances in all zones. A managed VM outside the
configured zone is never touched: its Cloud Computer is reported failed and the
provisioner logs `home-provisioner.provider.wrong-zone` with the VM, its zone
and the configured zone. Every other Cloud Computer is reconciled as usual. To
recover, do one of these:

- Delete the stray VM if it is not the Home's data, for example
  `gcloud compute instances delete "$VM" --project="$PROJECT" --zone="$ZONE"`.
- Remove its management label so the provisioner ignores it:
  `gcloud compute instances remove-labels "$VM" --project="$PROJECT" --zone="$ZONE" --labels=opensteer-managed-by`.
- Set `OPENSTEER_HOME_GCP_ZONE` back to the VM's zone.

A zone the listing cannot reach is logged as
`home-provisioner.provider.zones-unreachable` and skipped. The configured zone
is read on its own.

## Set up the project

Set `PROJECT` to the Compute project, `REGION` to the zone's region, and
`NETWORK` and `SUBNET` to the names you will use below. Set `PROVISIONER_SA`
to the Google service account email that Account already accepts. Its project
is `IDENTITY_PROJECT`. Set `CLUSTER_PROJECT` to the project that owns the GKE
cluster.

1. Enable Compute in the VM project. For a GKE KSA that impersonates the
   provisioner service account, enable the IAM Service Account Credentials API
   in the identity project and use the existing Workload Identity Federation
   setup. The metadata server issues the provisioner's access token on that
   same identity.

   ```sh
   gcloud services enable compute.googleapis.com --project="$PROJECT"
   gcloud services enable iamcredentials.googleapis.com --project="$IDENTITY_PROJECT"
   gcloud iam service-accounts add-iam-policy-binding "$PROVISIONER_SA" \
     --project="$IDENTITY_PROJECT" --role=roles/iam.workloadIdentityUser \
     --member="serviceAccount:${CLUSTER_PROJECT}.svc.id.goog[opensteer-system/home-provisioner]"
   kubectl annotate serviceaccount home-provisioner --namespace=opensteer-system \
     "iam.gke.io/gcp-service-account=$PROVISIONER_SA"
   ```

   [GKE workload identity instructions](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)

2. Create a custom-mode VPC with no additional ingress rules and a subnet with
   a CIDR sized for your fleet. Use either the IPv4 command or the dual-stack
   command. The provisioner installs TCP 80 and 443 ingress on its instance
   tag. SSH stays closed from the internet.

   ```sh
   gcloud compute networks create "$NETWORK" --project="$PROJECT" \
     --subnet-mode=custom --bgp-routing-mode=regional
   gcloud compute networks subnets create "$SUBNET" --project="$PROJECT" \
     --network="$NETWORK" --region="$REGION" --range=10.40.0.0/20
   # Dual-stack subnet with external IPv6, in place of the preceding command
   gcloud compute networks subnets create "$SUBNET" --project="$PROJECT" \
     --network="$NETWORK" --region="$REGION" --range=10.40.0.0/20 \
     --stack-type=IPV4_IPV6 --ipv6-access-type=EXTERNAL
   ```

   List every ingress rule in the VPC, including disabled rules. The only
   rules should be `opensteer-cloud-computers-v4` and, for external dual
   stack, `opensteer-cloud-computers-v6`.

   ```sh
   gcloud compute firewall-rules list --project="$PROJECT" \
     --filter="network~'/networks/${NETWORK}$' AND direction=INGRESS"
   ```

3. Check the regional static and in-use external IPv4 quotas. Budget one of
   each per VM and allow for reservations held by suspended VMs and pending
   operations. Budget another reservation during a replacement. The old VM
   keeps its address until the provisioner deletes it. The provisioner
   reserves the replacement's address before it stops the old VM. If Compute
   refuses the reservation, the old Home keeps running and stays reachable,
   the Cloud Computer is reported failed, and the log names the refusal (for
   example `"reasons":["quotaExceeded"]`). Enable Cloud Quotas if you need to
   request an increase. Use the quota ID and dimensions returned for the
   required metric.

   ```sh
   gcloud compute regions describe "$REGION" --project="$PROJECT" \
     --flatten='quotas[]' --filter='quotas.metric:(STATIC_ADDRESSES IN_USE_ADDRESSES)' \
     --format='table(quotas.metric,quotas.usage,quotas.limit)'
   gcloud services enable cloudquotas.googleapis.com --project="$PROJECT"
   gcloud beta quotas info list --service=compute.googleapis.com --project="$PROJECT"
   gcloud beta quotas preferences create --project="$PROJECT" \
     --service=compute.googleapis.com --quota-id="$QUOTA_ID" \
     --preferred-value="$ADDRESS_LIMIT" --dimensions="region=$REGION"
   ```

   [Compute quotas](https://cloud.google.com/compute/resource-usage)

4. Check the effective `constraints/compute.vmExternalIpAccess` policy.
   Instance names are generated as Homes are purchased. If an inherited policy
   blocks them, ask the organization administrator to permit external IPs in
   this dedicated project. This project override requires organization policy
   authority.

   ```sh
   gcloud org-policies describe compute.vmExternalIpAccess --effective --project="$PROJECT"
   PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
   cat > home-external-ip-policy.yaml <<EOF_POLICY
   name: projects/$PROJECT_NUMBER/policies/compute.vmExternalIpAccess
   spec:
     rules:
     - allowAll: true
   EOF_POLICY
   gcloud org-policies set-policy home-external-ip-policy.yaml
   ```

   [External IP organization policy](https://cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address)

5. Grant only the permissions used by the adapter. Save this as
   `home-provisioner-role.yaml`.

   ```yaml
   title: Opensteer Home Provisioner
   stage: GA
   includedPermissions:
     - compute.addresses.create
     - compute.addresses.delete
     - compute.addresses.get
     - compute.addresses.list
     - compute.addresses.setLabels
     - compute.addresses.use
     - compute.disks.create
     - compute.firewalls.create
     - compute.firewalls.get
     - compute.globalOperations.get
     - compute.images.useReadOnly
     - compute.instances.create
     - compute.instances.delete
     - compute.instances.get
     - compute.instances.list
     - compute.instances.setLabels
     - compute.instances.setMetadata
     - compute.instances.setTags
     - compute.instances.start
     - compute.instances.stop
     - compute.networks.updatePolicy
     - compute.regionOperations.get
     - compute.subnetworks.get
     - compute.subnetworks.use
     - compute.subnetworks.useExternalIp
     - compute.zoneOperations.get
     - compute.zoneOperations.list
   ```

   ```sh
   gcloud iam roles create opensteerHomeProvisioner --project="$PROJECT" \
     --file=home-provisioner-role.yaml
   gcloud projects add-iam-policy-binding "$PROJECT" \
     --member="serviceAccount:$PROVISIONER_SA" \
     --role="projects/$PROJECT/roles/opensteerHomeProvisioner"
   ```

   | Compute call                                 | Permissions                                                                                                                                                                                                                                                            |
   | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `addresses.insert`                           | `compute.addresses.create`, `compute.addresses.setLabels`                                                                                                                                                                                                              |
   | `addresses.get`                              | `compute.addresses.get`                                                                                                                                                                                                                                                |
   | `addresses.list`                             | `compute.addresses.list`                                                                                                                                                                                                                                               |
   | `addresses.delete`                           | `compute.addresses.delete`                                                                                                                                                                                                                                             |
   | `firewalls.insert`                           | `compute.firewalls.create`, `compute.networks.updatePolicy`                                                                                                                                                                                                            |
   | `firewalls.get`                              | `compute.firewalls.get`                                                                                                                                                                                                                                                |
   | `globalOperations.get`                       | `compute.globalOperations.get`                                                                                                                                                                                                                                         |
   | `instances.insert`                           | `compute.instances.create`, `compute.disks.create`, `compute.images.useReadOnly`, `compute.subnetworks.use`, `compute.subnetworks.useExternalIp`, `compute.addresses.use`, `compute.instances.setLabels`, `compute.instances.setMetadata`, `compute.instances.setTags` |
   | `instances.get`                              | `compute.instances.get`                                                                                                                                                                                                                                                |
   | `instances.list`, `instances.aggregatedList` | `compute.instances.list`                                                                                                                                                                                                                                               |
   | `instances.start`                            | `compute.instances.start`                                                                                                                                                                                                                                              |
   | `instances.stop`                             | `compute.instances.stop`                                                                                                                                                                                                                                               |
   | `instances.delete`                           | `compute.instances.delete`                                                                                                                                                                                                                                             |
   | `instances.setMetadata`                      | `compute.instances.setMetadata`                                                                                                                                                                                                                                        |
   | `instances.setTags`                          | `compute.instances.setTags`                                                                                                                                                                                                                                            |
   | `regionOperations.get`                       | `compute.regionOperations.get`                                                                                                                                                                                                                                         |
   | `subnetworks.get`                            | `compute.subnetworks.get`                                                                                                                                                                                                                                              |
   | `zoneOperations.get`                         | `compute.zoneOperations.get`                                                                                                                                                                                                                                           |
   | `zoneOperations.list`                        | `compute.zoneOperations.list`                                                                                                                                                                                                                                          |

   The default Ubuntu image is public. If using a private image in another
   project, grant `compute.images.useReadOnly` on that image as well. Home VMs
   have no attached service account.

## Set the deployment variables

| Provisioner variable              | Value                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENSTEER_HOME_GCP_PROJECT`      | Required Compute project ID.                                                                                                                                                      |
| `OPENSTEER_HOME_GCP_ZONE`         | Required zone, such as `us-central1-a`. This also selects the region.                                                                                                             |
| `OPENSTEER_HOME_GCP_NETWORK`      | Required VPC name.                                                                                                                                                                |
| `OPENSTEER_HOME_GCP_SUBNET`       | Required subnet name.                                                                                                                                                             |
| `OPENSTEER_HOME_GCP_MACHINE_TYPE` | Defaults to `e2-medium` with 2 vCPUs and 4 GiB of memory: the Home's own VM, with no browser in it. The Home sizes its services' limits from it.                                  |
| `OPENSTEER_HOME_GCP_IMAGE`        | Defaults to `projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`. Accepts a Compute image or image family resource path. Pin an image name to qualify a release. |
| `OPENSTEER_HOME_GCP_DISK_TYPE`    | Defaults to `pd-balanced`. Also accepts `pd-standard` and `pd-ssd`.                                                                                                               |
| `OPENSTEER_HOME_GCP_DISK_SIZE_GB` | Defaults to `30`.                                                                                                                                                                 |

Keep `OPENSTEER_ACCOUNT_URL`, `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID`,
`OPENSTEER_HOME_CLOUD_COMPUTER_DOMAIN` (Account's `OPENSTEER_CLOUD_COMPUTER_DOMAIN`, the only
names the provisioner touches in the zone) and `OPENSTEER_HOME_CLOUDFLARE_TOKEN` (or its
`_FILE` variant). The Google
deployment gets its access token from attached Workload Identity. It requires
no Google key.

Set Account's `OPENSTEER_CLOUD_COMPUTER_REGION` to the same region or zone and
`OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE=default` to delegate sizing to the
provisioner. `OPENSTEER_CLOUD_COMPUTER_REGION_LABEL` can override the display
label. Set `OPENSTEER_CLOUD_COMPUTER_IPV6=on` for AAAA publication and IPv6
on the Home's Compose ports when using the external dual-stack subnet.

See the machine requirements and release commands in the [Home deployment guide](../home/README.md).

## Browser pool hosts

Every Cloud Computer's browser runs in the browser pool; none runs in the person's own VM. The
provisioner manages Firecracker browser pool hosts in the same Compute project, VPC, subnet, and
zone as Cloud Computer Homes, and Account places one micro-VM per person's browser on them. The
pool is required on both sides: Account refuses to start without
`OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` and `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON`,
and `home-provisioner` refuses to start without `OPENSTEER_POOL_PROVISIONER_KEY`,
`OPENSTEER_POOL_HOME_CIDR` and `OPENSTEER_POOL_PROVISIONER_CIDR`. Account's operator pool commands
still warn if the provisioner holding the lease reported no pool key.

### Additional Google Cloud prerequisites

1. **Nested virtualization & Local SSDs:** Pool host VMs default to `n2-standard-8` with
   `enableNestedVirtualization: true`, `threadsPerCore: 1`, `onHostMaintenance: "TERMINATE"`, and
   NVMe Local SSD scratch disks (`OPENSTEER_POOL_LOCAL_SSD_COUNT`, default `1`). Confirm your
   project has N2 CPU and Local SSD quota in the configured zone.
2. **Cloud NAT on the VPC:** Pool host VMs are created with `--no-address` (internal VPC IPv4
   only). Configure a Cloud Router and Cloud NAT covering the pool subnet so pool hosts can reach
   HTTPS origins (release artifacts, Ubuntu updates, Account's `/boot`, `/boot-complete`, and
   `/slot-egress`, and upstream browser egress proxies) without public IP addresses.
   ```sh
   gcloud compute routers create "${NETWORK}-nat-router" --project="$PROJECT" \
     --network="$NETWORK" --region="$REGION"
   gcloud compute routers nats create "${NETWORK}-nat" --project="$PROJECT" \
     --router="${NETWORK}-nat-router" --region="$REGION" \
     --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
   ```
3. **Provisioner private-network reach:** The provisioner calls each pool host's signed admin port
   (`OPENSTEER_POOL_ADMIN_PORT`, default `7311`, HTTP over VPC) directly on the host's internal
   IPv4 address. Run the provisioner inside the same VPC (or peered/VPC-native GKE cluster) and set
   `OPENSTEER_POOL_PROVISIONER_CIDR` to the narrow CIDR of the provisioner's pods/nodes.
4. **VPC firewall rules:** In addition to `opensteer-cloud-computers-v4`/`v6`, the provisioner
   verifies or creates:
   - `opensteer-pool-hosts-home`: TCP `agentPort` (default `7310`) and `relayPort` (default
     `7312`) from tag `opensteer-cloud-computers` to tag `opensteer-pool-hosts`.
   - `opensteer-pool-hosts-admin`: TCP `OPENSTEER_POOL_ADMIN_PORT` (default `7311`) from
     `OPENSTEER_POOL_PROVISIONER_CIDR` to tag `opensteer-pool-hosts`.
5. **Additional IAM permissions:** Add `compute.disks.create`, `compute.disks.get`,
   `compute.disks.list`, `compute.disks.delete`, `compute.disks.setLabels`, and
   `compute.disks.use` to `opensteerHomeProvisioner` so the provisioner can manage durable profile
   disks.

### Pool variables and capacity sizing

Each port is configured in one place: `agentPort` and `relayPort` live in Account (because Account
publishes them in each Home's target and forwards them to the provisioner), and `adminPort` lives
in `home-provisioner`.

| Variable                                             | Where       | Value                                                                                                                                                                         |
| ---------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST`       | Account     | Required positive integer: browsers placed on one pool host.                                                                                                                  |
| `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON`         | Account     | Required: pool host installer URL/SHA-256 and pinned agent/relay/rootfs/kernel/egress artifacts.                                                                              |
| `OPENSTEER_CLOUD_COMPUTER_POOL_MACHINE_TYPE`         | Account     | Defaults to `n2-standard-8` (32 GiB RAM, nested-virt-capable Intel Ice Lake/Cascade Lake).                                                                                    |
| `OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB`          | Account     | Per-slot profile size in MiB (`64`–`1048576`, default `2048`).                                                                                                                |
| `OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB` | Account     | Durable profile disk size in GiB (default `500`). Account refuses configurations where `slotsPerHost * profileMib` exceeds 90% of disk size (10% reserved for ext4 overhead). |
| `OPENSTEER_CLOUD_COMPUTER_POOL_AGENT_PORT`           | Account     | Optional Home-to-agent port (default `7310`).                                                                                                                                 |
| `OPENSTEER_CLOUD_COMPUTER_POOL_RELAY_PORT`           | Account     | Optional Home-to-relay port (default `7312`).                                                                                                                                 |
| `OPENSTEER_POOL_PROVISIONER_KEY` (`_FILE`)           | Provisioner | Required Ed25519 private key (base64 PKCS8 DER or PEM) used to sign admin requests to pool hosts.                                                                             |
| `OPENSTEER_POOL_HOME_CIDR`                           | Provisioner | Required subnet CIDR of Cloud Computer Home VMs (for host-side `nftables` on agent/relay ports).                                                                              |
| `OPENSTEER_POOL_PROVISIONER_CIDR`                    | Provisioner | Required provisioner CIDR (for VPC firewall and host-side `nftables` on the admin port).                                                                                      |
| `OPENSTEER_POOL_ADMIN_PORT`                          | Provisioner | Optional provisioner-to-agent admin port (default `7311`).                                                                                                                    |
| `OPENSTEER_POOL_LOCAL_SSD_COUNT`                     | Provisioner | NVMe Local SSDs attached per pool host (`1`–`24`, default `1`).                                                                                                               |
| `OPENSTEER_POOL_PROFILE_DISK_TYPE`                   | Provisioner | Durable profile disk type (`pd-ssd`, `pd-balanced`, `pd-standard`; default `pd-ssd`).                                                                                         |

#### Simultaneous memory capacity and oversubscription

On the default `n2-standard-8` (32 GiB RAM) with 2048 MiB guests, the host reserves 10% for the
host OS (~3.2 GiB) and 1536 MiB for the egress proxy slice (up to 12 proxies at 128 MiB each),
leaving ~27.3 GiB for guests. At 2560 MiB per in-memory guest (`2048 + 512 MiB` cgroup ceiling),
**10 browsers fit in memory at the same time** (`OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST=10`
for zero oversubscription).

Setting `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` above 10 oversubscribes host RAM: inactive
browsers park to Local SSD so more people can share one host, but if more than 10 browsers on the
same host try to run at once, waking a sleeping browser can be refused until memory frees. Ensure
the durable profile disk fits every assigned slot with at least 10% ext4 filesystem headroom.

#### Failed hosts, replacement, and profile disks

- **Unenrolled host failures:** A new host that misses its readiness window before ever enrolling
  holds no slots; `home-provisioner` automatically replaces it in place up to twice. If it still
  fails to enrol after two automatic replacements, it stays `failed` with the reason shown in
  `pool-host-list` / `pool-host-show`.
- **Enrolled host failures and operator recovery:** A host that has already enrolled is **never**
  replaced automatically. Recover a failed host manually with `pool-host-replace <host-id>` (after
  inspecting `pool-host-show <host-id>`).
- **Effect of `pool-host-replace`:** Replacing a pool host hard-stops every running browser on that
  host so the durable profile disk can detach cleanly and reattach to the new instance. Every
  browser on the host starts cold on the replacement instance with its saved profile intact.
- **Durable profile disks are never swept:** The orphan sweep deletes abandoned pool VMs after the
  grace period, but never deletes durable profile disks. Untracked pool-labelled disks are logged
  (`home-provisioner.pool.untracked-profile-disk`) and left for an operator. A profile disk is
  deleted only through `pool-host-delete <host-id>` once zero slots remain in Account and either
  the running host's agent `list` confirms zero slots or the instance is observed off or absent
  (an unreachable running host waits).
- **Failed slot recovery:** A slot refused with a definite agent error (such as a full profile
  disk) is retried automatically no more often than every 10 minutes, reset immediately when its
  host is replaced, or retried at once with `pool-slot-retry <slot-id>`. Its `lastError` remains
  visible in operator views until it succeeds.
