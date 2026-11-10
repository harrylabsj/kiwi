import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 发布/供应链类测试会在临时目录内实际执行 tsc/build（负载下 20s 会误报
    // timeout）；统一放宽到 60s，真正挂死的测试仍有明确上限。
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
