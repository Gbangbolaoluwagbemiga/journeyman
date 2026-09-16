import { Badge } from "@/components/ui/badge";
import { Award, Star } from "lucide-react";
import type { Badge as BadgeType } from "@/lib/web3/types";

interface BadgeDisplayProps {
  badge: BadgeType;
  className?: string;
}

const badgeConfig: Record<
  BadgeType,
  { label: string; color: string; bgColor: string }
> = {
  Beginner: {
    label: "Beginner",
    color: "text-blue-700 dark:text-blue-300",
    bgColor: "bg-blue-100 dark:bg-blue-900/30",
  },
  Intermediate: {
    label: "Intermediate",
    color: "text-green-700 dark:text-green-300",
    bgColor: "bg-green-100 dark:bg-green-900/30",
  },
  Advanced: {
    label: "Advanced",
    color: "text-purple-700 dark:text-purple-300",
    bgColor: "bg-purple-100 dark:bg-purple-900/30",
  },
  Expert: {
    label: "Expert",
    color: "text-orange-700 dark:text-orange-300",
    bgColor: "bg-orange-100 dark:bg-orange-900/30",
  },
};

export function BadgeDisplay({ badge, className = "" }: BadgeDisplayProps) {
  const config = badgeConfig[badge] || badgeConfig.Beginner;

  return (
    <Badge
      className={`${config.bgColor} ${config.color} border-0 gap-1 ${className}`}
    >
      <Award className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

interface RatingDisplayProps {
  averageRating?: number;
  ratingCount?: number;
  showCount?: boolean;
  className?: string;
}

export function RatingDisplay({
  averageRating = 0,
  ratingCount = 0,
  showCount = true,
  className = "",
}: RatingDisplayProps) {
  if (ratingCount === 0) {
    return (
      <div
        className={`flex items-center gap-1 text-muted-foreground ${className}`}
      >
        <Star className="h-4 w-4" />
        <span className="text-sm">No ratings yet</span>
      </div>
    );
  }

  const fullStars = Math.floor(averageRating);
  const hasHalfStar = averageRating % 1 >= 0.5;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-4 w-4 ${
              star <= fullStars
                ? "fill-yellow-400 text-yellow-400"
                : star === fullStars + 1 && hasHalfStar
                  ? "fill-yellow-200 text-yellow-400"
                  : "text-gray-300"
            }`}
          />
        ))}
      </div>
      <div className="flex items-center gap-1 text-sm">
        <span className="font-medium">{averageRating.toFixed(1)}</span>
        {showCount && (
          <span className="text-muted-foreground">({ratingCount})</span>
        )}
      </div>
    </div>
  );
}
