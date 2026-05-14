// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Composition } from "remotion";
import { DEMO_DURATION_IN_FRAMES, DEMO_FPS, SharedMemoryDemo } from "./SharedMemoryDemo";

export const RemotionRoot = () => {
  return (
    <Composition
      id="SharedMemoryDemo"
      component={SharedMemoryDemo}
      durationInFrames={DEMO_DURATION_IN_FRAMES}
      fps={DEMO_FPS}
      width={1280}
      height={720}
    />
  );
};
