# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# LangChain Deep Agents Code sandbox image.

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

RUN set -eu; \
    dcode_path="$(command -v dcode 2>/dev/null || true)"; \
    if [ "$dcode_path" != "/usr/local/bin/dcode" ]; then \
        echo "ERROR: expected dcode at /usr/local/bin/dcode, got ${dcode_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/dcode; \
    /usr/local/bin/dcode --version

# Copy config generator, wrapper, startup script, and shared blueprint files.
COPY agents/langchain-deepagents-code/generate-config.ts /opt/nemoclaw-deepagents-code/generate-config.ts
COPY agents/langchain-deepagents-code/dcode-wrapper.sh /usr/local/lib/nemoclaw/dcode-wrapper.sh
COPY agents/langchain-deepagents-code/start.sh /usr/local/bin/nemoclaw-start
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
RUN chmod 444 /opt/nemoclaw-deepagents-code/generate-config.ts \
    && chmod 755 /usr/local/bin/nemoclaw-start /usr/local/lib/nemoclaw/dcode-wrapper.sh \
    && chmod -R a+rX /opt/nemoclaw-blueprint \
    && mv /usr/local/bin/dcode /usr/local/bin/dcode.real \
    && install -m 0755 /usr/local/lib/nemoclaw/dcode-wrapper.sh /usr/local/bin/dcode \
    && /usr/local/bin/dcode.real --version

ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
ARG NEMOCLAW_PROVIDER_KEY=inference
ARG NEMOCLAW_UPSTREAM_PROVIDER=nvidia
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_WEB_SEARCH_ENABLED=0
ARG NEMOCLAW_BUILD_ID=default
ARG NEMOCLAW_DARWIN_VM_COMPAT=0

ENV HOME=/sandbox \
    PATH="/usr/local/bin:${PATH}" \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED} \
    NEMOCLAW_BUILD_ID=${NEMOCLAW_BUILD_ID} \
    DEEPAGENTS_CODE_NO_UPDATE_CHECK=1 \
    DEEPAGENTS_CODE_AUTO_UPDATE=0 \
    DEEPAGENTS_CODE_OPENAI_API_KEY=nemoclaw-managed-inference \
    OPENAI_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL}

WORKDIR /sandbox
USER sandbox

RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/ \
    && node --experimental-strip-types /opt/nemoclaw-deepagents-code/generate-config.ts \
    && chmod 660 /sandbox/.deepagents/config.toml

USER root
RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.deepagents; \
        find /sandbox/.deepagents -type d -exec chmod a+rwx {} +; \
        chmod a+rw /sandbox/.bashrc /sandbox/.profile; \
    fi

USER sandbox
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
