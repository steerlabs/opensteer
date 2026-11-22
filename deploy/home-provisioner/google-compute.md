# Google Compute Engine for Opensteer Cloud Computers

Use a dedicated Compute project and VPC. A provisioner deployment manages one
provider and one Compute zone. Account must run the server-reference migration
before the provisioner switches to Google. Give the new deployment its own
Account desired state and DNS configuration if the existing deployment has
Hetzner computers.

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
| `OPENSTEER_HOME_PROVIDER`         | `google`. Omit it for Hetzner.                                                                                                                                                    |
| `OPENSTEER_HOME_GCP_PROJECT`      | Required Compute project ID.                                                                                                                                                      |
| `OPENSTEER_HOME_GCP_ZONE`         | Required zone, such as `us-central1-a`. This also selects the region.                                                                                                             |
| `OPENSTEER_HOME_GCP_NETWORK`      | Required VPC name.                                                                                                                                                                |
| `OPENSTEER_HOME_GCP_SUBNET`       | Required subnet name.                                                                                                                                                             |
| `OPENSTEER_HOME_GCP_MACHINE_TYPE` | Defaults to `e2-standard-4` with 4 vCPUs and 16 GiB of memory.                                                                                                                    |
| `OPENSTEER_HOME_GCP_IMAGE`        | Defaults to `projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`. Accepts a Compute image or image family resource path. Pin an image name to qualify a release. |
| `OPENSTEER_HOME_GCP_DISK_TYPE`    | Defaults to `pd-balanced`. Also accepts `pd-standard` and `pd-ssd`.                                                                                                               |
| `OPENSTEER_HOME_GCP_DISK_SIZE_GB` | Defaults to `30`.                                                                                                                                                                 |

Keep `OPENSTEER_ACCOUNT_URL`, `OPENSTEER_HOME_CLOUDFLARE_ZONE_ID` and
`OPENSTEER_HOME_CLOUDFLARE_TOKEN` (or its `_FILE` variant). The Google
deployment gets its access token from attached Workload Identity. It requires
no Google key or Hetzner token.

Set Account's `OPENSTEER_CLOUD_COMPUTER_REGION` to the same region or zone and
`OPENSTEER_CLOUD_COMPUTER_SERVER_TYPE=default` to delegate sizing to the
provisioner. `OPENSTEER_CLOUD_COMPUTER_REGION_LABEL` can override the display
label. Set `OPENSTEER_CLOUD_COMPUTER_IPV6=on` for AAAA publication and IPv6
on the Home's Compose ports when using the external dual-stack subnet.

See the machine requirements and release commands in the [Home deployment guide](../home/README.md).

## Browser pool hosts (optional)

When pooling is enabled (`OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` set in Account and
`OPENSTEER_POOL_PROVISIONER_KEY` set in the provisioner), the provisioner also manages Firecracker
browser pool hosts in the same Compute project, VPC, subnet, and zone. Leave both unset to keep
pooling completely disabled.

### Network prerequisites

1. **Same VPC subnet, internal-only pool hosts:** Pool host VMs are created with no external IP
   (`--no-address`), nested virtualization enabled (`enableNestedVirtualization: true`,
   `threadsPerCore: 1`, `onHostMaintenance: TERMINATE`), NVMe Local SSDs for scratch/saved guest
   state, and a separate durable persistent disk (`autoDelete: false`) mounted at the agent's
   `driver.profilesRoot` for slot profiles only.
2. **Cloud NAT:** Create a Cloud Router and Cloud NAT on the subnet's region so pool host VMs can
   reach HTTPS origins (release artifacts, Ubuntu updates, Account's `/boot`, `/boot-complete`, and
   `/slot-egress`, and upstream browser egress proxies) without public IP addresses.
   ```sh
   gcloud compute routers create "${NETWORK}-nat-router" --project="$PROJECT" \
     --network="$NETWORK" --region="$REGION"
   gcloud compute routers nats create "${NETWORK}-nat" --project="$PROJECT" \
     --router="${NETWORK}-nat-router" --region="$REGION" \
     --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
   ```
3. **Provisioner private-network reach:** The provisioner calls each pool host's signed admin port
   (`7311`, HTTP over VPC) directly on the host's internal IPv4 address. Run the provisioner inside
   the same VPC (or peered/VPC-native GKE cluster) and set `OPENSTEER_POOL_PROVISIONER_CIDR` to the
   narrow CIDR of the provisioner's pods/nodes.
4. **VPC firewall rules:** In addition to `opensteer-cloud-computers-v4`/`v6`, the provisioner
   verifies or creates:
   - `opensteer-pool-hosts-home`: TCP `7310` and `7312` from tag `opensteer-cloud-computers` to tag
     `opensteer-pool-hosts`.
   - `opensteer-pool-hosts-admin`: TCP `7311` from `OPENSTEER_POOL_PROVISIONER_CIDR` to tag
     `opensteer-pool-hosts`.
5. **Additional IAM permissions:** Add `compute.disks.get`, `compute.disks.list`,
   `compute.disks.delete`, `compute.disks.setLabels`, and `compute.disks.use` to
   `opensteerHomeProvisioner` so the provisioner can manage durable profile disks.

### Pool variables and capacity sizing

| Variable | Where | Value |
| --- | --- | --- |
| `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` | Account | Positive integer; enables pooling for newly created Cloud Computers. |
| `OPENSTEER_CLOUD_COMPUTER_POOL_RELEASE_JSON` | Account | Pool host installer URL/SHA-256 and pinned agent/relay/rootfs/kernel/egress artifacts. |
| `OPENSTEER_CLOUD_COMPUTER_POOL_MACHINE_TYPE` | Account | Defaults to `n2-standard-8` (nested-virt-capable Intel Ice Lake/Cascade Lake). |
| `OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_MIB` | Account | Per-slot profile size in MiB (`64`–`1048576`, default `2048`). |
| `OPENSTEER_CLOUD_COMPUTER_POOL_PROFILE_DISK_SIZE_GB` | Account | Durable profile disk size in GiB (default `500`). Account refuses configurations where `slotsPerHost * profileMib` exceeds 90% of disk size (10% reserved for ext4 overhead). |
| `OPENSTEER_POOL_PROVISIONER_KEY` (`_FILE`) | Provisioner | Ed25519 private key (base64 PKCS8 DER or PEM) used to sign admin requests to pool hosts. |
| `OPENSTEER_POOL_HOME_CIDR` | Provisioner | Subnet CIDR of Cloud Computer Home VMs (for host-side `nftables` on 7310/7312). |
| `OPENSTEER_POOL_PROVISIONER_CIDR` | Provisioner | Provisioner CIDR (for VPC firewall and host-side `nftables` on 7311). |
| `OPENSTEER_POOL_LOCAL_SSD_COUNT` | Provisioner | NVMe Local SSDs attached per pool host (`1`–`24`, default `1`). |
| `OPENSTEER_POOL_PROFILE_DISK_TYPE` | Provisioner | Durable profile disk type (`pd-ssd`, `pd-balanced`, `pd-standard`; default `pd-ssd`). |

Because `OPENSTEER_CLOUD_COMPUTER_POOL_SLOTS_PER_HOST` counts assigned slots rather than
simultaneously active browsers, operators may oversubscribe host RAM (inactive guests park to
Local SSD). Size `slotsPerHost` for your expected concurrent working set and ensure the durable
profile disk fits every assigned slot with at least 10% filesystem headroom.
