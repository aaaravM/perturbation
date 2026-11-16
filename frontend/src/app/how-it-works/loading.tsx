import { ArticleSkeleton, BarcodeSkeleton } from "@/components/site/page-skeletons";

export default function Loading() {
  return <ArticleSkeleton titleWidth="min(100%, 30rem)" leadLines={3} phoneLeadLines={6} sections={8} intro={<BarcodeSkeleton />} />;
}
