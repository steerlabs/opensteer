interface SkeletonProps {
    id?: string
    lines?: number
}

export function Skeleton({ id, lines = 3 }: SkeletonProps): JSX.Element {
    return (
        <div
            id={id}
            className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4"
        >
            {Array.from({ length: lines }, (_, index) => (
                <div
                    key={index}
                    className="h-3 animate-pulse rounded-full bg-slate-200"
                    style={{ width: `${90 - index * 12}%` }}
                />
            ))}
        </div>
    )
}
