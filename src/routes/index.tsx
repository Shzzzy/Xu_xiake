import { createFileRoute } from "@tanstack/react-router";
import { PlannerPrototype } from "@/components/planner/PlannerPrototype";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <PlannerPrototype />;
}
