// Step 4: what SPHEREx measured for the challenge's five test stars, against the catalogues.
// A table on wide screens; on phones each row becomes a short labelled block.

import type { ValidationRow } from "@/lib/how-it-works";
import { cn } from "@/lib/utils";
import { RISE, delay } from "./motion-classes";
import { Reveal } from "./reveal";

const CELL = "py-3 pr-5 align-top max-md:py-0.5 max-md:pr-0";
const LABELLED = "max-md:before:mr-2 max-md:before:text-fg-faint max-md:before:content-[attr(data-label)]";

export function ValidationTable({ rows }: { rows: ValidationRow[] }) {
  return (
    <Reveal className="max-w-4xl">
      <table className="w-full border-collapse text-left text-meta">
        <caption className="sr-only">
          Measurements of the five test stars by this project, compared with catalogue values
        </caption>
        <thead className="max-md:sr-only">
          <tr className="border-b border-hair-strong text-fg-faint">
            <th scope="col" className="py-2 pr-5 font-normal">
              Star and quantity
            </th>
            <th scope="col" className="py-2 pr-5 font-normal">
              Measured here
            </th>
            <th scope="col" className="py-2 pr-5 font-normal">
              Catalogue
            </th>
            <th scope="col" className="py-2 font-normal">
              Agreement
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={`${r.target}-${r.quantity}`}
              className={cn("border-b border-hair max-md:flex max-md:flex-col max-md:gap-1 max-md:py-3", RISE)}
              style={delay(i, 60)}
            >
              <th scope="row" className={cn(CELL, "font-normal")}>
                <span className="block text-ui text-fg">{r.target}</span>
                <span className="block text-fg-dim">{r.quantity}</span>
              </th>
              <td data-label="Measured" className={cn(CELL, LABELLED, "text-fg")}>
                {r.measured}
              </td>
              <td data-label="Catalogue" className={cn(CELL, LABELLED, "text-fg-dim")}>
                {r.catalogue}
              </td>
              <td data-label="Agreement" className={cn(CELL, LABELLED, r.ok ? "text-fg-dim" : "text-fg")}>
                {r.agreement}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Reveal>
  );
}
