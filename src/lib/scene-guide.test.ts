import test from "node:test";
import assert from "node:assert/strict";
import { sceneDestinations } from "../data/scene-catalog.ts";
import { buildSceneGuide } from "./scene-guide.ts";

test("every catalog scene has highlights, experiences and a recommended duration", () => {
  for (const destination of sceneDestinations) {
    const guide = buildSceneGuide(destination);
    assert.ok(guide.highlights.length >= 2, `${destination.name} is missing highlights`);
    assert.ok(guide.experiences.length >= 2, `${destination.name} is missing experiences`);
    assert.ok(
      guide.experiences.every((experience) => experience.label && experience.duration),
      `${destination.name} is missing experience duration`,
    );
    assert.ok(
      guide.experiences.every((experience) => /(小时|分钟)/.test(experience.duration)),
      `${destination.name} has an invalid experience duration`,
    );
    assert.ok(guide.recommendedTime.length > 0, `${destination.name} is missing time`);
    assert.ok(guide.timing.length > 0, `${destination.name} is missing timing guidance`);
  }
});

test("a water town guide uses its own highlights and slow-travel duration", () => {
  const destination = sceneDestinations.find((item) => item.id === "wuzhen");
  assert.ok(destination);
  const guide = buildSceneGuide(destination);
  assert.ok(guide.experiences.some((experience) => experience.label === "摇橹船"));
  assert.equal(guide.recommendedTime, "半天–1 天");
});