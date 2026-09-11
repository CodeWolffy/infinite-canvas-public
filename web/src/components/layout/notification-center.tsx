import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Drawer, Empty, Tag } from "antd";
import { Bell } from "lucide-react";

import { getNotifications, readNotification } from "@/services/api/platform-operations";
import { useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";

export function NotificationCenter() {
    const [open, setOpen] = useState(false);
    const session = useUserStore((state) => state.sessionVersion);
    const user = useUserStore((state) => state.user);
    const theme = useThemeStore((state) => state.theme);
    const client = useQueryClient();
    const query = useQuery({ queryKey: ["notifications", session], queryFn: getNotifications, enabled: Boolean(user), refetchInterval: open || user?.role === "admin" ? 2500 : false });
    const read = useMutation({ mutationFn: readNotification, onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }) });
    const entries = query.data?.notifications || [];
    return <><Badge dot={entries.some((entry) => !entry.read)}><button type="button" aria-label="通知中心" title="通知中心" style={{ color: canvasThemes[theme].node.text }} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10" onClick={() => setOpen(true)}><Bell className="size-4" /></button></Badge>
        <Drawer title="通知中心" open={open} onClose={() => setOpen(false)} size={420} extra={<Button type="text" onClick={() => void query.refetch()}>刷新</Button>}>
            {query.error ? <Alert type="error" title={query.error.message} /> : entries.length ? <div>{entries.map((entry) => <article key={entry.id} className="border-b border-border py-5 first:pt-0"><div className="flex items-start justify-between gap-3"><h3 className="font-medium">{entry.title}</h3>{entry.read ? null : <Tag color="blue">未读</Tag>}</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{entry.content}</p><div className="mt-3 flex items-center justify-between gap-3"><time className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</time>{entry.read ? null : <Button type="text" size="small" onClick={() => read.mutate(entry.id)}>标为已读</Button>}</div></article>)}</div> : <Empty description="暂无通知" />}
        </Drawer>
    </>;
}
