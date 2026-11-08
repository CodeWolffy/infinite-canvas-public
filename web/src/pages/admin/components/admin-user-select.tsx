import { useDeferredValue, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Select, Spin, type SelectProps } from "antd";
import { getAdminUsersPage } from "@/services/api/admin-users";
import { useUserStore } from "@/stores/use-user-store";

type Props = Pick<SelectProps<string>, "value" | "onChange" | "allowClear" | "className" | "placeholder" | "disabled" | "id">;

export function AdminUserSelect({ onChange, ...props }: Props) {
    const session = useUserStore((state) => state.sessionVersion);
    const [search, setSearch] = useState("");
    const keyword = useDeferredValue(search.trim());
    const [selected, setSelected] = useState<{ value: string; label: string; session: number }>();
    const query = useInfiniteQuery({
        queryKey: ["admin", "user-options", session, keyword],
        initialPageParam: 1,
        queryFn: ({ pageParam }) => getAdminUsersPage({ page: pageParam, size: 200, keyword }),
        getNextPageParam: (last, pages) => pages.reduce((count, page) => count + page.users.length, 0) < last.total ? pages.length + 1 : undefined,
    });
    const options = (query.data?.pages.flatMap((page) => page.users) || []).map((user) => ({ value: user.id, label: `${user.displayName} · ${user.username}` }));
    const loadMore = () => { if (query.hasNextPage && !query.isFetching) void query.fetchNextPage(); };
    return <Select<string> {...props} showSearch={{ filterOption: false, onSearch: setSearch }} loading={query.isFetching} options={options}
        onChange={(value, option) => {
            const item = Array.isArray(option) ? option[0] : option;
            setSelected(value && item ? { value, label: String(item.label), session } : undefined);
            onChange?.(value, option);
        }}
        labelRender={({ value, label }) => label || (selected?.session === session && selected.value === value ? selected.label : value)}
        notFoundContent={query.isPending ? <Spin size="small" /> : query.isError ? "用户加载失败" : "没有匹配用户"}
        onPopupScroll={(event) => { const target = event.currentTarget; if (target.scrollTop + target.clientHeight >= target.scrollHeight) loadMore(); }}
        popupRender={(menu) => <>{menu}{query.isError ? <Button type="text" block onMouseDown={(event) => event.preventDefault()} onClick={() => void query.refetch()}>加载失败，重试</Button> : query.hasNextPage ? <Button type="text" block loading={query.isFetchingNextPage} onMouseDown={(event) => event.preventDefault()} onClick={loadMore}>加载更多用户</Button> : null}</>}
    />;
}
