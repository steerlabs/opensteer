import React, { useState } from "react";
import { createRoot } from "react-dom/client";

function ControlledFields() {
  const [values, setValues] = useState({ controlled: "initial", legacy: "initial" });
  window.fixture.react = values;
  return React.createElement(
    "section",
    null,
    ...Object.keys(values).map((id) =>
      React.createElement(
        "label",
        { key: id },
        id,
        React.createElement("input", {
          id,
          value: values[id],
          onChange: (event) => {
            const value = event.target.value;
            window.fixture.reactChanges++;
            setValues((previous) => ({ ...previous, [id]: value }));
          },
        }),
      ),
    ),
    React.createElement("output", { id: "react-state" }, JSON.stringify(values)),
  );
}

function PickupForm() {
  const [zip, setZip] = useState("");
  const [result, setResult] = useState(null);
  window.fixture.react = { zip };
  return React.createElement(
    "form",
    {
      id: "zip-form",
      onSubmit: async (event) => {
        event.preventDefault();
        const capacity = document.querySelector('[name="pl_dimensionCapacity"]:checked').value;
        const nonce = new URL(location.href).searchParams.get("nonce") ?? "local";
        const response = await fetch(`/pickup?${new URLSearchParams({ capacity, zip, nonce })}`);
        const pickup = await response.json();
        window.fixture.submissions.push(pickup);
        setResult(pickup);
      },
    },
    React.createElement(
      "label",
      null,
      "ZIP",
      React.createElement("input", {
        id: "zip",
        value: zip,
        onChange: (event) => {
          window.fixture.reactChanges++;
          setZip(event.target.value);
        },
      }),
    ),
    React.createElement("button", null, "Find pickup"),
    React.createElement("output", { id: "react-state" }, JSON.stringify({ zip })),
    result &&
      React.createElement(
        "section",
        { id: "pickup-result", "data-result-id": result.resultId },
        `${result.capacity.toUpperCase()} · ZIP ${result.zip}: ${result.availability}`,
      ),
  );
}

const pickupRoot = document.getElementById("pickup-react-root");
createRoot(pickupRoot ?? document.getElementById("react-root")).render(
  React.createElement(pickupRoot ? PickupForm : ControlledFields),
);
