import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");
const explorer = source("src/pages/cohorts/CohortExplorer.tsx");
const cohortChart = source("src/pages/cohorts/CohortChart.tsx");
const correlationChart = source("src/pages/cohorts/CorrelationChart.tsx");

describe("cohort explorer layout", () => {
  it("leaves the page root to the shared wide shell", () => {
    const root = /return \(\s*<div className="([^"]*)"/.exec(explorer);
    expect(root, "the explorer must have a page root").toBeTruthy();
    expect(root![1], "the page root must not set a width cap").not.toMatch(
      /\bmax-w-/,
    );
  });

  it("constrains controls but not data visualizations", () => {
    const controls = /data-layout-region="controls"\s+className="([^"]*)"/.exec(
      explorer,
    );
    expect(
      controls,
      "the metric and filter controls need a distinct region",
    ).toBeTruthy();
    expect(
      controls![1],
      "controls must keep labels and values close together",
    ).toMatch(/\bmax-w-/);

    for (const chart of [cohortChart, correlationChart]) {
      const region = /data-layout-region="chart"\s+className="([^"]*)"/.exec(
        chart,
      );
      expect(region, "each visualization needs a chart region").toBeTruthy();
      expect(region![1], "charts must use the shared shell width").not.toMatch(
        /\bmax-w-/,
      );
    }
  });
});
