// shadcn primitives — copied source, themed by apps/frontend/src/styles.css.
// They live here rather than in the app so that this package's own components
// can build on them without importing upward. Regenerate with the shadcn CLI in
// apps/frontend, then move the files here and repoint `@/lib/utils`.
export { Alert, AlertTitle, AlertDescription } from "./primitives/alert";
export { Badge } from "./primitives/badge";
export { Button } from "./primitives/button";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "./primitives/card";
export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./primitives/collapsible";
export { Input } from "./primitives/input";
export { Separator } from "./primitives/separator";
export { Skeleton } from "./primitives/skeleton";
export { Spinner } from "./primitives/spinner";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./primitives/table";
export { ToggleGroup, ToggleGroupItem } from "./primitives/toggle-group";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./primitives/tooltip";

export { cn } from "./lib/utils";

// tos-rag components
export { CutMark } from "./CutMark";
export { EvidenceCard } from "./EvidenceCard";
export { Swatch } from "./Swatch";
export { FactorBars, type FactorBar } from "./viz/FactorBars";
export { Heatmap, ContactSheet } from "./viz/Heatmap";
export { LatencyBoxes } from "./viz/LatencyBoxes";
