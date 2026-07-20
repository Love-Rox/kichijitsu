import type { TaskItem } from "../model/types";

interface TaskRowProps {
  task: TaskItem;
  /** 枡チェックボックスのクリックで呼ぶ(完了⇔未完了のトグル、App.tsx が楽観的更新 + 書き戻しを担う) */
  onToggle: (task: TaskItem) => void;
}

/**
 * 日付レーンの1件のタスク行(docs/google-tasks.md)。完了=枡の朱押印(brand の
 * 「完了=押印」体系そのもの、masu.css 参照)。EventBlock/AllDayBar と違い
 * ドラッグ・詳細ポップオーバーは v1 では対象外(枡タップで完了トグルのみ)。
 */
export function TaskRow({ task, onToggle }: TaskRowProps) {
  const completed = task.status === "completed";
  return (
    <div className="task-row">
      <button
        type="button"
        className="task-checkbox"
        aria-pressed={completed}
        aria-label={completed ? `${task.title} を未完了に戻す` : `${task.title} を完了にする`}
        onClick={() => onToggle(task)}
      >
        <span className={completed ? "masu masu--kichi" : "masu masu--empty"} aria-hidden="true" />
      </button>
      <span className={completed ? "task-title task-title--done" : "task-title"}>{task.title}</span>
    </div>
  );
}
