import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import MeasurementDetail from "../src/pages/MeasurementDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  deleteMeasurement: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn(),
  getFileUrl: vi.fn(),
  getMeasurement: vi.fn().mockResolvedValue({
    id: "measurement-42",
    sample_id: "sample-42",
    measured_on: "2026-09-15",
    pad_dim_um: null,
    pad_area_um2: null,
    updated_at: "2026-09-15",
  }),
  getSample: vi
    .fn()
    .mockResolvedValue({ id: "sample-42", sample_id: "SAMPLE-42" }),
  listFiles: vi.fn().mockResolvedValue([
    {
      id: "file-1",
      original_name: "run.csv",
      kind: "other",
      size_bytes: 10,
      parsed: {},
    },
  ]),
  updateMeasurement: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../src/lib/api", () => api);
vi.mock("../src/fields", () => ({
  EntityForm: () => null,
  useFieldDefs: () => ({ defs: [], lists: [], isLoading: false }),
}));
vi.mock("../src/pages/parts/MetaGrid", () => ({ MetaGrid: () => null }));
vi.mock("../src/pages/parts/FileDropzone", () => ({
  FileDropzone: () => null,
}));
vi.mock("../src/plot/useParsedFile", () => ({
  useParsedFile: () => ({ isLoading: false }),
}));
vi.mock("../src/plot/QuickPlot", () => ({ QuickPlot: () => null }));
vi.mock("../src/plot/PreviewTable", () => ({ PreviewTable: () => null }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function renderPage() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/measurements/measurement-42"]}>
          <Routes>
            <Route path="/measurements/:id" element={<MeasurementDetail />} />
            <Route path="/samples/:sampleId" element={null} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (button("Read")) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("measurement detail did not finish loading");
}

function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  ) as HTMLButtonElement;
}

function dialogButton(name: string) {
  return [...document.querySelectorAll('[role="dialog"] button')].find(
    (element) => element.textContent === name,
  ) as HTMLButtonElement;
}

async function openDeleteDialog() {
  await act(async () => {
    button("Edit").click();
  });
  await act(async () => {
    button("Delete measurement").click();
  });
}

async function typeConfirmation(value: string) {
  const confirmation = document.querySelector<HTMLInputElement>(
    "#delete-measurement-confirmation",
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(confirmation, value);
    confirmation.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  api.deleteMeasurement.mockClear();
});

describe("measurement deletion", () => {
  it("is unreachable on the default read tab", async () => {
    await renderPage();
    expect(button("Delete measurement")).toBeUndefined();
  });

  it("requires the exact measurement identifier before enabling deletion", async () => {
    await renderPage();
    await openDeleteDialog();
    const confirm = dialogButton("Delete measurement");
    expect(confirm.disabled).toBe(true);
    await typeConfirmation("measurement-42 ");
    expect(
      confirm.disabled,
      "a trailing-space near miss must not confirm deletion",
    ).toBe(true);
    await typeConfirmation("measurement-42");
    expect(confirm.disabled).toBe(false);
  });

  it("closes on Escape without deleting", async () => {
    await renderPage();
    await openDeleteDialog();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.deleteMeasurement).not.toHaveBeenCalled();
  });

  it("deletes exactly once after an exact confirmation", async () => {
    await renderPage();
    await openDeleteDialog();
    await typeConfirmation("measurement-42");
    await act(async () => {
      dialogButton("Delete measurement").click();
    });
    expect(api.deleteMeasurement).toHaveBeenCalledTimes(1);
    expect(api.deleteMeasurement).toHaveBeenCalledWith("measurement-42");
  });
});
