import decide from "./decide.mjs";
import extract from "./extract.mjs";

// Register a new task by adding its module here. A task module exports
// { id, label, summary, itemsKey, itemNoun, types, options?, validate, mockAnswers, mockMeta? }.
export const tasks = { [decide.id]: decide, [extract.id]: extract };

export function describeTasks() {
  return Object.fromEntries(
    Object.values(tasks).map((task) => [
      task.id,
      { id: task.id, label: task.label, summary: task.summary, itemsKey: task.itemsKey, itemNoun: task.itemNoun, types: task.types, options: task.options || [] },
    ]),
  );
}
