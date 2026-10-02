// 测试辅助：可控时钟 + 预置指引的服务实例。

import { CdcResponseService } from "../src/service.js";
import { SEED_GUIDELINE_V1 } from "../src/seed.js";

export function makeService(startAt = "2026-09-20T08:00:00+08:00") {
  let current = new Date(startAt);
  const service = new CdcResponseService({ now: () => current });
  const clock = {
    now: () => current,
    set(iso) {
      current = new Date(iso);
    },
    advanceHours(hours) {
      current = new Date(current.getTime() + hours * 3600_000);
    },
  };
  service.publishGuideline(SEED_GUIDELINE_V1);
  return { service, clock };
}

export const BASE_SUBMISSION = {
  reporter_contact: "138-0000-0001",
  meals: [{ eaten_at: "2026-09-19T18:30:00+08:00", location: "青山路家常菜馆", food_items: ["野生蘑菇汤"] }],
};
