<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Installer Guide — DGX Station GB300 (Local vLLM)

This guide covers the full installation of NemoClaw on a DGX Station GB300 using a
locally-served vLLM inference backend.

On Station hardware the installer presents an interactive model picker with three
options:

| # | Model                                       | HF token | Notes |
|---|---------------------------------------------|----------|-------|
| 1 | `Qwen/Qwen2.5-72B-Instruct`                 | optional | Open weights |
| 2 | `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` | optional | Open weights, reasoning-tuned |
| 3 | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | required | Gated; default |

A HuggingFace token is **required** for Nemotron and **strongly recommended** for the
open-weight models — unauthenticated downloads from the HF Hub are rate-limited and a
72B model can take 18+ minutes to download without one.

## Helper scripts

The repo ships two helper scripts in `scripts/`:

| Script                  | Purpose                                                                 |
|-------------------------|-------------------------------------------------------------------------|
| `scripts/install.sh`    | Full installer — dependency check, model picker, vLLM, gateway, onboard |
| `scripts/cleanup.sh`    | Tears down sandboxes, gateway, vLLM container; verifies GPU memory release. Pass `--all` to also purge cached HuggingFace model weights, `--yes` to skip the confirmation prompt |

See [Teardown for Re-testing](#teardown-for-re-testing) for the full cleanup
procedure.

---

## One-Time System Preparation

These steps only need to be done once per system.

### 1. Add your user to the docker group

OpenShell gateway management requires Docker socket access without `sudo`.
Running `openshell` as root causes TLS certificate ownership mismatches that
break the installer at step [4/8].

```bash
sudo usermod -aG docker $USER
# Open a new terminal for the group change to take effect
```

Verify:

```bash
docker ps   # should succeed without sudo
```

### 2. Fix any root-owned directories

If the installer was ever run with `sudo` previously, several directories may be
owned by root. Fix them before running again:

```bash
sudo chown -R $USER:$USER ~/.config/openshell
sudo chown -R $USER:$USER ~/.nvm
sudo chown -R $USER:$USER ~/.npm
sudo chown -R $USER:$USER ~/.nemoclaw
sudo chown -R $USER:$USER ~/NemoClaw          # adjust to your checkout path
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

### 3. Obtain a HuggingFace token

A token with read access to the gated Nemotron model is required, and recommended for
all other models so HuggingFace doesn't rate-limit the download:

- Accept the Nemotron license at <https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4>
- Create a token at <https://huggingface.co/settings/tokens>

The installer resolves the token from the first source available, in this order:

1. `HUGGING_FACE_HUB_TOKEN` env var
2. `HF_TOKEN` env var
3. `~/.cache/huggingface/token` (created by `huggingface-cli login`)
4. `~/.huggingface/token` (legacy CLI cache)

The recommended one-time setup is to log in with the HuggingFace CLI so the token is
persisted on disk and every subsequent install picks it up automatically with no
env-var dance:

```bash
pip install --user huggingface_hub
huggingface-cli login   # paste your hf_... token when prompted
```

Alternatively, export it per-shell:

```bash
export HUGGING_FACE_HUB_TOKEN="hf_..."
```

When the installer launches vLLM it logs which source it used:

```text
[INFO]  HuggingFace token: using ~/.cache/huggingface/token (huggingface-cli login) — gated models and faster downloads enabled
```

If no token is found, the installer continues but warns that gated models will fail and
open-weight downloads will be slow.

---

## Step 1: Start vLLM (optional — installer handles this automatically)

On a Station the installer always runs the model picker before launching vLLM, even
when an existing container is detected, so you can confirm or switch the loaded model.
It then:

1. Selects the highest-VRAM GPU automatically.
2. Reuses the running vLLM container if the loaded model matches the chosen one.
3. Otherwise stops the container, frees GPU memory, pulls the new model, and launches
   a fresh container. The replacement is logged in red, e.g.:

   ```text
   [WARN]  vLLM is running a different model — replacing it:
           Loaded:    nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4
           Requested: Qwen/Qwen2.5-72B-Instruct
           Stopping container 'nemoclaw-vllm'...
           Container removed.
           GPU 1 VRAM used: 245213 MiB → 802 MiB (memory released)
   ```

4. **Waits up to 60 minutes** for the HTTP `/health` endpoint to respond, parsing the
   container logs every 5 seconds to classify the current stage:

   ```text
   [vLLM] stage: downloading weights from HuggingFace
   [vLLM] downloading weights from HuggingFace — still loading… 12m45s elapsed (timeout in 47m15s)
   [vLLM] stage: loading weights into GPU
   [vLLM] loading weights into GPU — still loading… 18m12s elapsed (timeout in 41m48s)
   [vLLM] stage: capturing CUDA graphs
   ✓  vLLM ready on :8000 after 19m45s
   ```

   If the container exits or the timeout elapses, the installer aborts with the last
   30 lines of container logs and clear retry instructions — it never falls through to
   onboard while vLLM is still loading.

Start vLLM manually only if you want explicit control over GPU selection or model
parameters (e.g., during testing or when re-using an already-downloaded model).

### Find your compute GPU

On a DGX Station GB300 with a mixed GPU configuration (e.g., RTX PRO 6000 Workstation
on bus 0 + GB300 compute GPU on bus 1), use `nvidia-smi` to identify the right device index:

```bash
nvidia-smi -L
# GPU 0: NVIDIA RTX PRO 6000 Blackwell Workstation Edition ...
# GPU 1: NVIDIA GB300 ...
```

### Start the container

Replace `device=1` with the index of your compute GPU.

```bash
docker run --detach \
  --name nemoclaw-vllm \
  --restart unless-stopped \
  --network host \
  --gpus "device=1" \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  -e HF_TOKEN="${HUGGING_FACE_HUB_TOKEN}" \
  vllm/vllm-openai:latest \
  --model nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4 \
  --port 8000
```

> **Note on GPU flags:** `--gpus "device=1"` restricts the container to device 1 and
> remaps it to device 0 inside the container. Do **not** also set
> `-e CUDA_VISIBLE_DEVICES=1`; the two flags conflict and cause an
> `NVMLError_InvalidArgument` crash in vLLM's worker processes.
>
> **Note on `--network host`:** Required so the onboard wizard's curl probe can reach
> the server via any host IP. With bridge networking, Docker's userland proxy binds the
> host port immediately on container start — before vLLM is ready — causing false-positive
> readiness checks.

Wait for the server to be ready. First run downloads ~75 GB; subsequent runs load from
cache in ~5 minutes:

```bash
docker logs -f nemoclaw-vllm
# Wait for: INFO: Uvicorn running on http://0.0.0.0:8000
```

Verify it responds:

```bash
curl -s http://localhost:8000/v1/models | python3 -m json.tool
```

### Base URL for the installer wizard

When the onboard wizard asks for the base URL, include `/v1` and use the host's LAN
IP address rather than `localhost` — the gateway probe runs inside a Docker container
and needs a routable address:

```text
http://<host-lan-ip>:8000/v1
```

Find your LAN IP:

```bash
ip -4 addr show | grep "inet " | awk '{print $2}' | cut -d/ -f1
```

---

## Step 2: Start the OpenShell Gateway (optional — installer handles this)

If the gateway is not already running, the installer starts it automatically at step
[2/8]. The "Still starting gateway cluster... (Ns elapsed)" messages that appear during
first-time startup are normal — k3s initialisation takes 30–90 seconds.

Start the gateway manually only if you need it running before the installer, or to
verify it is healthy:

```bash
openshell gateway start --name nemoclaw
# Wait for: ✓ Gateway ready — Endpoint: https://127.0.0.1:8080
```

> **Important:** Always start the gateway as your regular user (not `sudo`). If the
> gateway is created by root, its TLS certificates are stored in root's config directory.
> When the installer then runs as the regular user, the certificate handshake fails with
> `invalid peer certificate: BadSignature`.

If the command fails with `Permission denied` on `~/.config/openshell/`, fix ownership
first (see One-Time System Preparation above).

---

## Step 3: Run the Installer

From the NemoClaw source checkout:

```bash
cd ~/NemoClaw && git pull
bash scripts/install.sh
```

> **Note:** You no longer need to prefix the command with
> `HUGGING_FACE_HUB_TOKEN="${HUGGING_FACE_HUB_TOKEN}"`. If you ran `huggingface-cli
> login` once during the one-time setup, the installer auto-discovers the token from
> `~/.cache/huggingface/token` and logs the source it used:
>
> ```text
> [INFO]  HuggingFace token: using ~/.cache/huggingface/token (huggingface-cli login) — gated models and faster downloads enabled
> ```
>
> Prefix with `HUGGING_FACE_HUB_TOKEN=hf_...` only if you have not logged in with the
> HuggingFace CLI and prefer the per-shell env-var approach.

### Choose a model

After the dependency-status table, the Station picker prompts:

```text
  ──────────────────────────────────────────────────
  Select inference model for this DGX Station
  ──────────────────────────────────────────────────
  1) Qwen2.5 72B Instruct         (open weights, no HF token required)
  2) DeepSeek-R1 Distill 70B      (open weights, no HF token required)
  3) Nemotron-3 Super 120B NVFP4  (gated — requires HF token)  [default]
  ──────────────────────────────────────────────────
  Choose 1-3 (Enter for default 3):
```

Press Enter for the Nemotron default, or type `1` / `2` for the open-weight options.
To skip the prompt entirely (CI / scripted installs), set
`NEMOCLAW_VLLM_MODEL=<exact-hf-id>` in the environment.

### Onboard wizard answers

| Prompt | Answer |
|--------|--------|
| Inference option | `3` — Other OpenAI-compatible endpoint |
| Base URL | `http://<host-lan-ip>:8000/v1` |
| API key | Any non-empty string (vLLM has no auth by default) |
| Model | The exact HuggingFace ID you picked above (run `curl -s http://localhost:8000/v1/models` to confirm) |
| Sandbox name | `my-assistant` (or any name you prefer) |
| Web search | `N` (unless you have a Brave API key) |
| Messaging | Enter to skip (or configure Slack/Discord/Telegram as needed) |
| Policy tier | `Open` (recommended for local use) |

The sandbox image build takes approximately 6–8 minutes on first run.

---

## Post-Installation Usage

### Connect to the sandbox

```bash
source ~/.bashrc   # pick up the updated PATH from nvm
nemoclaw my-assistant connect
```

Inside the sandbox:

```bash
# Terminal chat UI
openclaw tui

# Single-shot message
openclaw agent --agent main --local -m "hello" --session-id test
```

### Open the dashboard in a browser

The installer prints a one-time tokenized URL at the end of installation.
**Save it — it is not shown again.**

```text
http://127.0.0.1:18789/#token=<auth-token>
```

If you are accessing the DGX Station remotely, forward port 18789 from the station
to your local machine via SSH:

```bash
ssh -L 18789:127.0.0.1:18789 nvidia@<dgx-station-ip>
```

If the port forward stopped (e.g., after a reboot), restart it:

```bash
openshell forward start --background 18789 my-assistant
```

### Check sandbox status

```bash
nemoclaw my-assistant status
nemoclaw my-assistant logs --follow
```

### Switch inference model

The simplest way to swap models is to re-run the installer — the Station model picker
will offer the three choices, the loaded vLLM model is replaced (with a red warning and
GPU-memory verification), and the sandbox is recreated to point at the new model.

```bash
cd ~/NemoClaw && git pull
bash scripts/install.sh --fresh
```

To change the model that the OpenShell gateway routes to **without** restarting vLLM
or the sandbox, you can also call:

```bash
openshell inference set -g nemoclaw \
  --model <hf-model-id> \
  --provider compatible-endpoint
```

Note that the vLLM container only serves the model it was launched with; pointing the
gateway at a different model than vLLM is loading will fail.

---

## Model Cache and Disk Space

vLLM downloads model weights from HuggingFace into the host directory
`~/.cache/huggingface/hub/`, mounted into the container via
`-v ~/.cache/huggingface:/root/.cache/huggingface`. **Stopping or removing the
`nemoclaw-vllm` container does not delete cached weights** — they persist across
container lifecycles so subsequent loads of the same model take seconds instead of
minutes.

### Where the cache lives

The cache directory is on whichever filesystem holds `$HOME`. On a DGX Station GB300
this is the system NVMe SSD by default (typically 1.92 TB or 3.84 TB). Check with:

```bash
df -h "$HOME/.cache/huggingface/"
mount | grep "$(stat -c %m "$HOME")"
```

### Disk usage per model

| Model | On-disk size |
|-------|--------------|
| `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | ~75 GB (NVFP4 4-bit) |
| `Qwen/Qwen2.5-72B-Instruct`                       | ~135 GB (BF16) |
| `deepseek-ai/DeepSeek-R1-Distill-Llama-70B`       | ~130 GB (BF16) |

If you swap through all three Station picker options, the cache grows to roughly
340 GB. List exactly what is cached:

```bash
du -sh ~/.cache/huggingface/hub/models--*/ | sort -h
```

### Free up space

The installer never deletes cached weights automatically. To purge **every** cached
model in one shot (and tear down the rest of NemoClaw at the same time), use the
helper script:

```bash
bash scripts/cleanup.sh --all
```

To remove a single model manually:

```bash
rm -rf ~/.cache/huggingface/hub/models--Qwen--Qwen2.5-72B-Instruct
```

…or use the HuggingFace CLI's interactive cleaner (lets you select what to delete and
shows reclaimed bytes):

```bash
huggingface-cli scan-cache
huggingface-cli delete-cache
```

### Move the cache off the system NVMe

If the system NVMe is filling up but you have a larger secondary NVMe or HDD mounted
elsewhere, relocate the cache with the `HF_HOME` env var. Set it persistently in
`~/.bashrc` and rsync the existing cache once:

```bash
mkdir -p /mnt/data/huggingface
rsync -a ~/.cache/huggingface/ /mnt/data/huggingface/
echo 'export HF_HOME=/mnt/data/huggingface' >> ~/.bashrc
source ~/.bashrc
rm -rf ~/.cache/huggingface
```

The vLLM container reads `HF_HOME` from the environment when it is exported in the
shell that runs the installer, so subsequent `bash scripts/install.sh` runs will mount
the new path automatically.

### What happens when the disk fills up mid-download

vLLM will exit non-zero when the underlying `safetensors` write fails. The installer
detects this via the "container exited" check in the readiness wait and aborts with
the last 30 lines of container logs. Free up space and re-run with `--fresh`.

---

## Teardown for Re-testing

Use this procedure when cycling through installs during testing. It tears down only
the NemoClaw-specific resources and leaves Docker, Node.js, and the model cache intact.

### Quick teardown (recommended)

The repo ships `scripts/cleanup.sh` which performs every step below in the right order
and verifies that GPU memory is released. Run it from the repo root:

```bash
bash scripts/cleanup.sh           # standard teardown, prompts for confirmation
bash scripts/cleanup.sh --yes     # skip confirmation (scripted teardowns)
bash scripts/cleanup.sh --all     # standard teardown + purge HuggingFace model cache
```

What the script does:

1. Stops every sandbox registered in `~/.nemoclaw/sandboxes.json` (not just `my-assistant`).
2. Destroys the OpenShell gateway named `nemoclaw`.
3. Captures `nvidia-smi` VRAM before vLLM teardown, stops and removes the
   `nemoclaw-vllm` container, then re-samples VRAM until it stabilises and prints
   the before/after used MiB.
4. Removes `~/.nemoclaw/onboard-session.json` so the installer starts fresh.
5. With `--all`, additionally deletes every `~/.cache/huggingface/hub/models--*`
   directory and reports the bytes reclaimed.

### Manual teardown (if you can't run the script)

Tear down in reverse startup order to avoid orphaned containers and stale gateway
state:

```bash
# 1. Stop the sandbox(es) — repeat for each name in ~/.nemoclaw/sandboxes.json
nemoclaw my-assistant stop 2>/dev/null || true

# 2. Destroy the gateway (removes the OpenShell k3s cluster)
openshell gateway destroy --name nemoclaw --force

# 3. Stop and remove the vLLM container
docker stop nemoclaw-vllm && docker rm nemoclaw-vllm

# 4. Remove the onboard session file so the installer starts fresh
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

Then re-run the installer:

```bash
cd ~/NemoClaw && git pull
bash scripts/install.sh --fresh
```

On a clean install the installer prompts for a model, launches vLLM, waits up to
60 minutes for it to be healthy (with stage-by-stage progress), then proceeds to the
onboard wizard. You do not need to start vLLM or the gateway manually.

### Automatic backup before re-installation

When the installer finds an existing sandbox, it automatically calls `nemoclaw backup-all`
before doing anything destructive. Snapshots are stored as numbered archives:

```text
~/.nemoclaw/rebuild-backups/
  my-assistant-backup-1.tar.gz
  my-assistant-backup-2.tar.gz   ← increments on each re-run
```

To restore a backup after a failed re-installation:

```bash
ls ~/.nemoclaw/rebuild-backups/
nemoclaw my-assistant snapshot restore <backup-name>
```

---

## Uninstalling

The uninstaller is a single script that removes all NemoClaw host-side resources.
Docker, Node.js, npm, and Ollama are **not** touched.

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

### What the uninstaller removes

- All OpenShell sandboxes, the NemoClaw gateway, and registered inference providers
- NemoClaw-related Docker containers, images, and volumes (including `nemoclaw-vllm`)
- `~/.nemoclaw/`, `~/.config/openshell/`, `~/.config/nemoclaw/`
- The global `nemoclaw` npm package and CLI shim
- The `openshell` binary (unless `--keep-openshell` is passed)
- NemoClaw-managed swap file (if any)
- Shell profile PATH entries added by the installer

### What the uninstaller does NOT remove

- Docker, Node.js, npm, and nvm
- Ollama and its models (pass `--delete-models` to remove NemoClaw-pulled Ollama models)
- The HuggingFace model cache (`~/.cache/huggingface/`) — remove manually if needed:

```bash
rm -rf ~/.cache/huggingface/hub/models--nvidia--NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4
```

### Flags

| Flag | Effect |
|------|--------|
| `--yes` | Skip the confirmation prompt (useful for scripted teardowns) |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Remove NemoClaw-pulled Ollama models |

Example — non-interactive full teardown including Ollama models:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh \
  | bash -s -- --yes --delete-models
```

---

## Troubleshooting

### `invalid peer certificate: BadSignature` at step [4/8]

The gateway was started with `sudo` but the installer runs as the regular user.
The TLS certificates end up in different config directories.

Fix: destroy the gateway and restart it without `sudo`:

```bash
sudo openshell gateway destroy --name nemoclaw --force
sudo chown -R $USER:$USER ~/.config/openshell
openshell gateway start --name nemoclaw
```

### `Permission denied` on `~/.local/bin/nemoclaw` or `node_modules`

Leftover root-owned files from a previous `sudo` run. Fix:

```bash
sudo chown -R $USER:$USER ~/NemoClaw ~/.npm ~/.nvm ~/.nemoclaw ~/.config/openshell
```

### `ln: failed to create symbolic link '.../workspace/media': No such file or directory`

Fixed in the `Dockerfile` as of commit `c56e89aa`. Pull the latest and rerun.

### vLLM `NVMLError_InvalidArgument`

Caused by combining `--gpus "device=N"` with `-e CUDA_VISIBLE_DEVICES=N`.
Remove the `CUDA_VISIBLE_DEVICES` env var — `--gpus "device=N"` already restricts
and remaps the device to index 0 inside the container.

### Onboard wizard validation fails with `exit 7` (connection refused) on port 8000

The installer should never fall through to onboard with vLLM still loading — it polls
the HTTP `/health` endpoint for up to 60 minutes, parses container logs to classify
the load stage, and aborts cleanly with retry instructions if vLLM does not come up.
If you see exit 7 anyway, vLLM either crashed or rebooted between the readiness check
and the wizard probe. Diagnose with:

```bash
docker ps | grep nemoclaw-vllm
docker logs --tail 80 nemoclaw-vllm
curl -sf http://localhost:8000/health && echo healthy || echo "not ready"
```

Once `/health` returns 200, type `retry` in the wizard.

### Session file owned by root

If `~/.nemoclaw/onboard-session.json` is owned by root (from a previous `sudo` run),
the installer cannot write to it:

```bash
sudo rm -f /home/$USER/.nemoclaw/onboard-session.json
```

### vLLM `401 Unauthorized` or `404 Not Found` when downloading the model

**Wrong model ID.** The NVIDIA API / NIM catalog name for Nemotron-3 Super is
`nvidia/nemotron-3-super-120b-a12b`, but that identifier does not exist on HuggingFace.
vLLM fetches weights from HuggingFace and requires the HuggingFace repository name:

```text
nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4   ← correct (HuggingFace)
nvidia/nemotron-3-super-120b-a12b                ← wrong (NIM/NGC API name only)
```

A 401 means the HuggingFace token is missing or not exported in the container's
environment. A 404 means the model ID itself is wrong.

### NGC vLLM container cannot resolve HuggingFace

If you use the NGC-hosted vLLM image (`nvcr.io/nvidia/vllm:...`) instead of the
Docker Hub image (`vllm/vllm-openai:latest`), the container may fail to reach
`huggingface.co` due to NGC proxy or DNS restrictions in the container's network
namespace. Switch to `--network host` or use the Docker Hub image. The `docker run`
command in Step 1 already uses `--network host` and `vllm/vllm-openai:latest`.

### Installer launches a new vLLM container instead of reusing the existing one

The installer reuses a running vLLM container only when the loaded model matches the
one selected in the Station picker. If the picker selection differs from what the
container is serving, the container is stopped, GPU memory is verified released, and a
fresh container is launched with the new model. This is the expected behavior on a
model swap — look for the red `replacing it` block in the install log.

If you wanted to reuse the existing container, re-run the installer and pick the
already-loaded model at the picker. To check what is currently loaded:

```bash
docker inspect --format '{{join .Config.Cmd " "}}' nemoclaw-vllm | grep -oP '(?<=--model )\S+'
curl -sf http://localhost:8000/health && echo "healthy" || echo "not ready"
```

### HuggingFace download is slow or warns "unauthenticated requests"

The installer logs the token source at the start of the vLLM launch step. If you see:

```text
[WARN]  HuggingFace token: not provided — open models will download unauthenticated
```

…vLLM is fetching weights without auth and HF will rate-limit you (a 72B model takes
18+ minutes that way). Set up `huggingface-cli login` once (see
**One-Time System Preparation → Obtain a HuggingFace token**) and re-run the installer.

### Dashboard port oscillates between 18789 and 18790 across reinstalls

A previous install left an `openshell forward` process bound to the dashboard port,
so on the next install the wizard's allocator sees the port as taken and bumps to the
next free one. Each reinstall flips between the two ports.

Stop the stale forward(s) before re-running the installer:

```bash
openshell forward list
openshell forward stop <port>     # for each running entry
```

Or, if you don't mind losing the active forward, kill all forwards owned by the
sandbox:

```bash
openshell forward list | awk 'NR>1 && /running/i {print $3}' \
  | xargs -I{} openshell forward stop {}
```

### vLLM aborts with "container exited before becoming healthy"

The installer streams the last 30 lines of container logs before exiting. The most
common causes:

- **Out of memory** — the chosen model doesn't fit on the selected GPU. Re-run the
  installer and pick a smaller model, or set `NEMOCLAW_VLLM_MODEL` to a smaller HF ID.
- **HuggingFace 401** — the model is gated and no token was found. Run
  `huggingface-cli login`, then `bash scripts/install.sh --fresh`.
- **HuggingFace 404** — wrong model ID. Use the exact HF repo name, not a NIM/NGC
  catalog name.
