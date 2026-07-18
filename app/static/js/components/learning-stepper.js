const LEARNING_STEPS = ["learn", "check", "apply"];

function labelForStep(step) {
  return step[0].toUpperCase() + step.slice(1);
}

export function renderLearningStepper({ container, active, detail = "" }) {
  const group = document.createElement("div");
  group.className = "learning-stepper-group";
  const stepper = document.createElement("ol");
  stepper.className = "learning-stepper";
  stepper.setAttribute("aria-label", "Learning progress");

  for (const step of LEARNING_STEPS) {
    const item = document.createElement("li");
    item.textContent = labelForStep(step);
    if (step === active) {
      item.classList.add("is-active");
      item.setAttribute("aria-current", "step");
    }
    stepper.append(item);
  }

  group.append(stepper);
  if (detail) {
    const detailNode = document.createElement("p");
    detailNode.className = "learning-step-detail";
    detailNode.textContent = detail;
    group.append(detailNode);
  }

  container.append(group);
  return group;
}
