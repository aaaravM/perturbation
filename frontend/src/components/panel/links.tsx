// Links out. SIMBAD goes through the CfA mirror (CDS Strasbourg is degraded).

import { ArrowUpRightIcon } from "lucide-react";

export function defaultLinks(ra: number, dec: number, simbadId: string | null): { label: string; url: string }[] {
  const coo = `${ra.toFixed(5)} ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}`;
  return [
    simbadId
      ? { label: "SIMBAD (CfA mirror)", url: `https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=${encodeURIComponent(simbadId)}` }
      : {
          label: "SIMBAD (CfA mirror)",
          url: `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${encodeURIComponent(coo)}&CooFrame=ICRS&Radius=2&Radius.unit=arcmin`,
        },
    { label: "Gaia archive (ESA)", url: "https://gea.esac.esa.int/archive/" },
    { label: "SPHEREx at IRSA", url: "https://irsa.ipac.caltech.edu/Missions/spherex.html" },
    { label: "WISE images at IRSA", url: "https://irsa.ipac.caltech.edu/applications/wise/" },
  ];
}

export function LinkList({ links }: { links: { label: string; url: string }[] }) {
  return (
    <ul className="flex flex-col">
      {links.map((link) => (
        <li key={link.url}>
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group flex items-center justify-between gap-3 rounded-sm py-1.5 text-meta text-fg-dim transition-colors hover:text-fg"
          >
            {link.label}
            <ArrowUpRightIcon
              className="size-3.5 text-fg-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg"
              aria-hidden
            />
          </a>
        </li>
      ))}
    </ul>
  );
}
