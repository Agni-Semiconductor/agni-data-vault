import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Modal, Spinner } from "../components/ui";
import { EntityForm, useFieldDefs } from "../fields";
import {
  deleteFile,
  deleteMeasurement,
  getFileUrl,
  getMeasurement,
  getSample,
  listFiles,
  updateMeasurement,
  uploadFile,
} from "../lib/api";
import { type PlotKind } from "../plot/parseFile";
import { QuickPlot } from "../plot/QuickPlot";
import { PreviewTable } from "../plot/PreviewTable";
import { useParsedFile } from "../plot/useParsedFile";
import { MetaGrid } from "./parts/MetaGrid";
import { FileDropzone } from "./parts/FileDropzone";

type UploadRow = {
  name: string;
  size: number;
  state: "uploading" | "done" | "error" | "duplicate";
  pct: number;
  message?: string;
};
const displayBytes = (value: number | null) =>
  value === null
    ? "—"
    : value >= 1024 * 1024
      ? `${(value / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(value / 1024))} KB`;
const plotKinds: PlotKind[] = [
  "dciv",
  "aciv",
  "pund",
  "pulse",
  "cv",
  "board_csv",
  "other",
];
const imageExtensions = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".svg"];
const isImageFile = (file: { kind?: string | null; original_name: string }) =>
  String(file.kind) === "plot_png" ||
  imageExtensions.some((extension) =>
    file.original_name.toLowerCase().endsWith(extension),
  );
const useElementWidth = <T extends HTMLElement>() => {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref: setNode, width };
};

export default function MeasurementDetail() {
  const plotHost = useElementWidth<HTMLDivElement>();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [activeTab, setActiveTab] = useState<"read" | "edit">("read");
  const [edit, setEdit] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [error, setError] = useState("");
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [url, setUrl] = useState<string>();
  const measurementQuery = useQuery({
    queryKey: ["measurement", id],
    queryFn: () => getMeasurement(id),
    enabled: Boolean(id),
  });
  const fields = useFieldDefs("measurement", { includeInactive: true });
  const sampleQuery = useQuery({
    queryKey: ["sample", measurementQuery.data?.sample_id],
    queryFn: () => getSample(measurementQuery.data!.sample_id),
    enabled: Boolean(measurementQuery.data?.sample_id),
  });
  const filesQuery = useQuery({
    queryKey: ["files", id],
    queryFn: () => listFiles(id),
    enabled: Boolean(id),
  });
  const measurement = measurementQuery.data;
  const sample = sampleQuery.data;
  const files = filesQuery.data ?? [];
  const selected =
    files.find((file) => file.id === selectedId) ??
    files.find((file) => file.kind === "raw_xls" || file.kind === "raw_csv");
  const dataFile = files.find(
    (file) => file.kind === "raw_xls" || file.kind === "raw_csv",
  );
  const imageFile = files.find((file) => isImageFile(file));
  useEffect(() => {
    if (sample && measurement)
      document.title = `${sample.sample_id} · ${measurement.measured_on ?? "measurement"} · Agni Data Vault`;
  }, [sample, measurement]);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    if (selected)
      void getFileUrl(selected)
        .then((next) => {
          if (alive) setUrl(next);
        })
        .catch((reason: unknown) => {
          if (alive)
            setError(reason instanceof Error ? reason.message : String(reason));
        });
    return () => {
      alive = false;
    };
  }, [selected]);
  const selectedIsImage = Boolean(selected && isImageFile(selected));
  const parsedState = useParsedFile(
    selected && url && !selectedIsImage
      ? {
          url,
          name: selected.original_name,
          key: selected.sha256 ?? selected.id,
        }
      : null,
  );
  if (measurementQuery.isLoading || fields.isLoading || sampleQuery.isLoading)
    return <Spinner />;
  if (
    measurementQuery.error ||
    sampleQuery.error ||
    fields.error ||
    filesQuery.error
  )
    return (
      <p className="text-red-600">
        {
          (
            measurementQuery.error ??
            sampleQuery.error ??
            fields.error ??
            filesQuery.error
          )?.message
        }
      </p>
    );
  if (!measurement || !sample)
    return (
      <div>
        <p>Measurement not found.</p>
        <Link className="text-agni-orange underline" to="/samples">
          Back to samples
        </Link>
      </div>
    );
  const pad =
    measurement.pad_shape && measurement.pad_dim_um !== null
      ? `${measurement.pad_shape} ${measurement.pad_dim_um} µm${measurement.pad_area_um2 !== null ? ` · ${measurement.pad_area_um2.toFixed(1)} µm²` : ""}`
      : null;
  const receive = async (incoming: File[]) => {
    for (const file of incoming) {
      setUploads((rows) => [
        ...rows,
        { name: file.name, size: file.size, state: "uploading", pct: 0 },
      ]);
      try {
        await uploadFile(measurement, sample, file, (pct) =>
          setUploads((rows) =>
            rows.map((row) =>
              row.name === file.name && row.state === "uploading"
                ? { ...row, pct }
                : row,
            ),
          ),
        );
        setUploads((rows) =>
          rows.map((row) =>
            row.name === file.name ? { ...row, state: "done", pct: 100 } : row,
          ),
        );
      } catch (reason: unknown) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setUploads((rows) =>
          rows.map((row) =>
            row.name === file.name
              ? {
                  ...row,
                  state: message.startsWith("duplicate:")
                    ? "duplicate"
                    : "error",
                  message,
                }
              : row,
          ),
        );
      }
    }
    await client.invalidateQueries({ queryKey: ["files", id] });
  };
  const closeDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setDeleteConfirmation("");
  };
  return (
    <div className="space-y-6">
      <nav className="text-sm text-agni-slate">
        <Link className="text-agni-orange" to="/samples">
          Samples
        </Link>{" "}
        /{" "}
        <Link className="text-agni-orange" to={`/samples/${sample.sample_id}`}>
          {sample.sample_id}
        </Link>{" "}
        / {measurement.measured_on ?? "Undated"} {measurement.kind ?? ""}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex gap-2">
            <Badge tone="blue">{measurement.kind ?? "unknown"}</Badge>
            <span className="text-lg font-semibold">
              {measurement.measured_on ?? "Undated"}
            </span>
          </div>
          <p className="mt-2 text-sm text-agni-slate">
            {measurement.measured_by ?? "Unknown operator"}
            {measurement.device_address
              ? ` · ${measurement.device_address}`
              : ""}
          </p>
          {pad ? (
            <p className="text-sm text-agni-slate">{pad}</p>
          ) : (
            <Badge tone="amber" className="mt-2">
              pad geometry missing — needed for J and P plots
            </Badge>
          )}
        </div>
        <Button onClick={() => setActiveTab("edit")}>Edit measurement</Button>
      </header>
      <div
        className="flex gap-1 border-b border-border-subtle"
        role="tablist"
        aria-label="Measurement sections"
      >
        <Button
          size="sm"
          variant={activeTab === "read" ? "primary" : "ghost"}
          role="tab"
          aria-selected={activeTab === "read"}
          onClick={() => setActiveTab("read")}
        >
          Read
        </Button>
        <Button
          size="sm"
          variant={activeTab === "edit" ? "primary" : "ghost"}
          role="tab"
          aria-selected={activeTab === "edit"}
          onClick={() => setActiveTab("edit")}
        >
          Edit
        </Button>
      </div>
      {activeTab === "read" && (
        <>
          <MetaGrid
            defs={fields.defs}
            lists={fields.lists}
            row={measurement}
            onEdit={() => setActiveTab("edit")}
          />
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Files</h2>
            <FileDropzone
              onFiles={receive}
              disabled={uploads.some((upload) => upload.state === "uploading")}
              accept=".xls,.xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.bmp,.gif,.svg"
            />
            {uploads.length > 0 && (
              <div className="space-y-1 text-sm">
                {uploads.map((upload, index) => (
                  <div
                    key={`${upload.name}-${index}`}
                    className={
                      upload.state === "error"
                        ? "text-danger"
                        : upload.state === "duplicate"
                          ? "text-agni-slate"
                          : ""
                    }
                  >
                    {upload.name} ({displayBytes(upload.size)}) —{" "}
                    {upload.state === "uploading"
                      ? `uploading ${upload.pct}%`
                      : upload.state === "duplicate"
                        ? "already attached"
                        : upload.state}
                    {upload.state === "error" && `: ${upload.message}`}
                  </div>
                ))}
              </div>
            )}
            <div className="overflow-x-auto rounded-lg border border-border-subtle shadow-card">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-agni-crimson text-xs uppercase tracking-[.08em] text-white">
                  <tr>
                    <th className="p-3">Name</th>
                    <th className="p-3">Kind</th>
                    <th className="p-3">Size</th>
                    <th className="p-3">SHA-256</th>
                    <th className="p-3">Detected</th>
                    <th className="p-3">Run</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr key={file.id} className="border-t border-border-subtle">
                      <td className="p-3">
                        <button
                          className="text-left text-agni-orange underline"
                          onClick={() => setSelectedId(file.id)}
                        >
                          {file.original_name}
                        </button>
                      </td>
                      <td className="p-3">
                        <Badge>{file.kind}</Badge>
                      </td>
                      <td className="p-3">{displayBytes(file.size_bytes)}</td>
                      <td className="p-3 font-mono">
                        {file.sha256?.slice(0, 8) ?? "—"}
                      </td>
                      <td className="p-3">
                        {typeof file.parsed.detected_kind === "string"
                          ? file.parsed.detected_kind
                          : "—"}
                      </td>
                      <td className="p-3">
                        {typeof file.parsed.run_number === "number"
                          ? file.parsed.run_number
                          : "—"}
                      </td>
                      <td className="p-3">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Download ${file.original_name}`}
                            onClick={() =>
                              void getFileUrl(file).then((downloadUrl) =>
                                window.open(
                                  downloadUrl,
                                  "_blank",
                                  "noopener,noreferrer",
                                ),
                              )
                            }
                          >
                            Download
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${file.original_name}`}
                            onClick={async () => {
                              if (
                                window.confirm(`Delete ${file.original_name}?`)
                              ) {
                                await deleteFile(file);
                                await client.invalidateQueries({
                                  queryKey: ["files", id],
                                });
                              }
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!files.length && (
                    <tr>
                      <td className="p-5 text-agni-slate" colSpan={7}>
                        No files attached.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {selected && (
              <section className="rounded-lg border border-border-subtle bg-white p-4 shadow-card">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">
                    Preview: {selected.original_name}
                  </h3>
                  <div className="flex items-center gap-2">
                    {dataFile && imageFile && (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant={selectedIsImage ? "ghost" : "secondary"}
                          onClick={() => setSelectedId(dataFile.id)}
                        >
                          Data
                        </Button>
                        <Button
                          size="sm"
                          variant={selectedIsImage ? "secondary" : "ghost"}
                          onClick={() => setSelectedId(imageFile.id)}
                        >
                          Image
                        </Button>
                      </div>
                    )}
                    <Badge tone={selectedIsImage ? "amber" : "blue"}>
                      {selectedIsImage ? "Image" : "Data"}
                    </Badge>
                  </div>
                </div>
                {selectedIsImage ? (
                  url ? (
                    <figure className="space-y-2">
                      <img
                        src={url}
                        alt={selected.original_name}
                        className="max-h-[32rem] w-auto rounded-md border border-border-subtle bg-white"
                      />
                      <a
                        className="text-sm text-agni-orange underline"
                        href={url}
                        target="_blank"
                        rel="noopener,noreferrer"
                      >
                        Download {selected.original_name}
                      </a>
                    </figure>
                  ) : (
                    <Spinner />
                  )
                ) : parsedState.isLoading || !url ? (
                  <Spinner />
                ) : parsedState.error ? (
                  <p className="text-danger">{parsedState.error}</p>
                ) : parsedState.parsed ? (
                  <div className="space-y-6">
                    <div
                      ref={plotHost.ref}
                      className="mx-auto w-full max-w-3xl"
                    >
                      <QuickPlot
                        parsed={parsedState.parsed}
                        kind={
                          plotKinds.includes(measurement.kind as PlotKind)
                            ? (measurement.kind as PlotKind)
                            : (parsedState.parsed.detected_kind ?? undefined)
                        }
                        height={Math.round(
                          Math.min(
                            520,
                            Math.max(320, (plotHost.width ?? 400) * 0.72),
                          ),
                        )}
                        title={selected.original_name.replace(/\.[^.]+$/, "")}
                      />
                    </div>
                    <PreviewTable
                      parsed={parsedState.parsed}
                      onSheetChange={(sheet) => void parsedState.reparse(sheet)}
                    />
                  </div>
                ) : null}
              </section>
            )}
          </section>
        </>
      )}
      {activeTab === "edit" && (
        <section className="space-y-6">
          <Button onClick={() => setEdit(true)}>Edit measurement</Button>
          <section className="border-t border-danger pt-6">
            <h2 className="font-semibold text-danger">Danger zone</h2>
            <p className="mt-1 text-sm text-agni-slate">
              Deleting this measurement destroys it and its {files.length}{" "}
              file(s).
            </p>
            <Button
              className="mt-3"
              variant="danger"
              onClick={() => setDeleteDialogOpen(true)}
            >
              Delete measurement
            </Button>
          </section>
        </section>
      )}
      <Modal
        open={edit}
        onClose={() => setEdit(false)}
        title="Edit measurement"
        size="xl"
      >
        <>
          {error && <p className="mb-3 text-sm text-danger">{error}</p>}
          <EntityForm
            entity="measurement"
            defs={fields.defs}
            lists={fields.lists}
            row={measurement}
            onCancel={() => setEdit(false)}
            onSubmit={async (payload) => {
              setError("");
              try {
                await updateMeasurement(
                  measurement.id,
                  payload,
                  measurement.updated_at,
                );
                await client.invalidateQueries({
                  queryKey: ["measurement", id],
                });
                setEdit(false);
              } catch (reason) {
                const message =
                  reason instanceof Error ? reason.message : String(reason);
                setError(
                  message.includes("conflict")
                    ? "Conflict: this measurement changed. Reload and try again."
                    : message,
                );
              }
            }}
          />
        </>
      </Modal>
      <Modal
        open={deleteDialogOpen}
        onClose={closeDeleteDialog}
        title="Delete measurement"
      >
        <div className="space-y-4">
          <p>
            This will permanently destroy measurement{" "}
            <code className="font-mono">{measurement.id}</code> and its{" "}
            {files.length} file(s).
          </p>
          <label
            className="block text-sm font-medium text-agni-ink"
            htmlFor="delete-measurement-confirmation"
          >
            Type <code className="font-mono">{measurement.id}</code> to confirm
          </label>
          <input
            id="delete-measurement-confirmation"
            aria-label="Type the measurement identifier to confirm deletion"
            className="w-full rounded-md border border-border-subtle bg-white px-3 py-2 text-sm outline-none focus:border-agni-orange"
            value={deleteConfirmation}
            onChange={(event) => setDeleteConfirmation(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDeleteDialog}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteConfirmation !== measurement.id}
              onClick={async () => {
                await deleteMeasurement(measurement.id);
                navigate(`/samples/${sample.sample_id}`);
              }}
            >
              Delete measurement
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
