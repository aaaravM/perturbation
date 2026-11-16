import { ArticleSkeleton } from "@/components/site/page-skeletons";

export default function Loading() {
  return <ArticleSkeleton titleWidth="min(100%, 38rem)" leadLines={4} phoneLeadLines={8} sections={6} />;
}
