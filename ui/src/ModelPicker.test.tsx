import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import ModelPicker, { modelChoices } from "./ModelPicker";
import type { ModelState } from "./ComposerTools";
const models: ModelState = {
  currentModelId: "alpha[medium]",
  defaultModelId: "alpha[medium]",
  availableModels: [
    { modelId: "alpha[low]", name: "Alpha (low)" },
    { modelId: "alpha[medium]", name: "Alpha (medium)" },
    { modelId: "beta[low]", name: "Beta (low)" },
    { modelId: "beta[high]", name: "Beta (high)" },
  ],
};
function Picker({ state = models }: { state?: ModelState }) {
  const [model, setModel] = useState("");
  return (
    <>
      <ModelPicker
        models={state}
        model={model}
        onModel={setModel}
        disabled={false}
      />
      <output aria-label="Selected ID">{model || state.currentModelId}</output>
    </>
  );
}
afterEach(cleanup);
const open = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /Select effort and model/ }),
  );
it("chooses effort before filtering exact model IDs, preserving the current family when possible", () => {
  render(<Picker />);
  open();
  expect(
    screen.getByRole("slider", { name: "Reasoning effort" }),
  ).toHaveAttribute("aria-valuetext", "Medium");
  fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), {
    target: { value: "0" },
  });
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent("alpha[low]");
  fireEvent.click(screen.getByRole("button", { name: "Choose model: Alpha" }));
  const choices = screen.getByRole("group", { name: "Model for Low effort" });
  expect(within(choices).getAllByRole("radio")).toHaveLength(2);
  fireEvent.click(within(choices).getByRole("radio", { name: "Beta" }));
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent("beta[low]");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("offers only real effort/model pairs and resets both to the captured original default", () => {
  render(<Picker state={{ ...models, currentModelId: "beta[high]" }} />);
  open();
  fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), {
    target: { value: "1" },
  });
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent(
    "alpha[medium]",
  );
  fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), {
    target: { value: "2" },
  });
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent("beta[high]");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Reset model and effort to session default",
    }),
  );
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent(
    "alpha[medium]",
  );
  expect(
    screen.getByRole("slider", { name: "Reasoning effort" }),
  ).toHaveAttribute("aria-valuetext", "Medium");
});
it("preserves opaque IDs and does not infer effort from a display name", () => {
  const state = {
    currentModelId: "opaque/model-v1",
    availableModels: [
      { modelId: "opaque/model-v1", name: "Model (high)" },
      { modelId: "other-id", name: "Other" },
    ],
  };
  render(<Picker state={state} />);
  open();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(
    screen.getByText("This model uses its default reasoning effort."),
  ).toBeVisible();
  expect(screen.queryByRole("radio", { name: "High" })).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Reset model and effort to session default",
    }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Choose model: Model (high)" }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Other" }));
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent("other-id");
});
it("handles a missing current model and an empty option list without inventing an ID", () => {
  const { rerender } = render(
    <Picker
      state={{
        ...models,
        currentModelId: "removed",
        defaultModelId: "removed",
      }}
    />,
  );
  open();
  expect(
    screen.getByRole("button", {
      name: "Reset model and effort to session default",
    }),
  ).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<Picker state={{ currentModelId: "", availableModels: [] }} />);
  expect(screen.getByText("Model unavailable")).toBeVisible();
});

it("strips only the canonical effort suffix from the adapter display name", () => {
  expect(
    modelChoices({
      currentModelId: "gpt-6-astra[high]",
      availableModels: [
        { modelId: "gpt-6-astra[high]", name: "GPT-6 Astra (high)" },
      ],
    }),
  ).toEqual([
    {
      modelId: "gpt-6-astra[high]",
      name: "GPT-6 Astra (high)",
      base: "gpt-6-astra",
      effort: "high",
      title: "GPT-6 Astra",
    },
  ]);
});

it("keeps focus and opening side-effect free and explains a single supported effort", () => {
  render(
    <Picker
      state={{
        currentModelId: "alpha[high]",
        defaultModelId: "alpha[high]",
        availableModels: [{ modelId: "alpha[high]", name: "Alpha (high)" }],
      }}
    />,
  );
  open();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(screen.getByText("High is the available effort.")).toBeVisible();
  expect(screen.getByLabelText("Selected ID")).toHaveTextContent("alpha[high]");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.getByRole("button", { name: /Select effort and model/ }),
  ).toHaveFocus();
});
