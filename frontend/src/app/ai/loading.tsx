import { AiPartsSkeleton, ArticleSkeleton } from "@/components/site/page-skeletons";

export default function Loading() {
  return <ArticleSkeleton titleWidth="min(100%, 36rem)" leadLines={6} phoneLeadLines={10} sections={5} intro={<AiPartsSkeleton />} />;
}
