package platform

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestCanvasCollaborativeSaveMergesAndPreservesPersonalState(t *testing.T) {
	if os.Getenv("TEST_REDIS_ADDR") == "" { t.Skip("需要独立的 TEST_REDIS_ADDR") }
	a := testApp(t)
	ctx := context.Background()
	owner, ownerCookie := testUser(t, a, 0)
	editor, editorCookie := testUser(t, a, 0)
	viewer, viewerCookie := testUser(t, a, 0)
	id := uuid.NewString()
	base := canvasTestSnapshot("")
	base["nodes"] = []any{Row{"id":"n1", "type":"text", "position":Row{"x":0.0,"y":0.0}, "metadata":Row{"content":"原文"}}}
	if _,err:=a.DB.Exec(ctx,"INSERT INTO canvas_projects(id,user_id,title,snapshot) VALUES($1,$2,'协作画布',$3)",id,owner,jsonBytes(sharedCanvasSnapshot(base)));err!=nil{t.Fatal(err)}
	if _,err:=a.DB.Exec(ctx,"INSERT INTO canvas_members(project_id,user_id,role,status,invited_by) VALUES($1,$2,'editor','accepted',$4),($1,$3,'viewer','accepted',$4)",id,editor,viewer,owner);err!=nil{t.Fatal(err)}
	router:=a.Router()
	path:="/api/canvas-projects/"+id
	moving:=canvasTestSnapshot("")
	moving["nodes"]=[]any{Row{"id":"n1","type":"text","position":Row{"x":80.0,"y":0.0},"metadata":Row{"content":"原文"}}}
	moving["chatSessions"]=[]any{Row{"id":"private","messages":[]any{Row{"content":"所有者私聊"}}}}
	moving["activeChatId"]="private"
	first:=testRequest(router,"PUT",path,Row{"snapshot":moving,"baseSnapshot":base,"expectedRevision":0},ownerCookie)
	if first.Code!=200 { t.Fatalf("first save: %d %s",first.Code,first.Body.String()) }
	typing:=canvasTestSnapshot("")
	typing["nodes"]=[]any{Row{"id":"n1","type":"text","position":Row{"x":0.0,"y":0.0},"metadata":Row{"content":"协作者修改"}}}
	second:=testRequest(router,"PUT",path,Row{"snapshot":typing,"baseSnapshot":base,"expectedRevision":0},editorCookie)
	if second.Code!=200 { t.Fatalf("disjoint save should merge: %d %s",second.Code,second.Body.String()) }
	project:=object(responseRow(t,second)["project"])
	snapshot:=object(project["snapshot"])
	node:=object(snapshot["nodes"].([]any)[0])
	if object(node["position"])["x"]!=80.0 || object(node["metadata"])["content"]!="协作者修改" || len(snapshot["chatSessions"].([]any))!=0 { t.Fatalf("incorrect merged snapshot: %v",snapshot) }
	if integer(project["revision"])!=2 { t.Fatalf("shared revision: %v",project) }
	repeat:=testRequest(router,"PUT",path,Row{"snapshot":typing,"baseSnapshot":base,"expectedRevision":0},editorCookie)
	if repeat.Code!=200 || integer(object(responseRow(t,repeat)["project"])["revision"])!=2 { t.Fatalf("retry must be idempotent: %d %s",repeat.Code,repeat.Body.String()) }
	typing["nodes"]=[]any{Row{"id":"n1","type":"text","position":Row{"x":0.0,"y":0.0},"metadata":Row{"content":"冲突文字"}}}
	conflict:=testRequest(router,"PUT",path,Row{"snapshot":typing,"baseSnapshot":base,"expectedRevision":0},ownerCookie)
	if conflict.Code!=409 { t.Fatalf("same field should conflict: %d %s",conflict.Code,conflict.Body.String()) }
	before,err:=one(ctx,a.DB,"SELECT revision,updated_at FROM canvas_projects WHERE id=$1",id);if err!=nil{t.Fatal(err)}
	view:=testRequest(router,"PUT",path,Row{"viewport":Row{"x":123.0,"y":30.0,"k":2.0},"expectedRevision":0},viewerCookie)
	if view.Code!=200 { t.Fatalf("viewer personal viewport: %d %s",view.Code,view.Body.String()) }
	after,err:=one(ctx,a.DB,"SELECT revision,updated_at FROM canvas_projects WHERE id=$1",id);if err!=nil{t.Fatal(err)}
	if string(jsonBytes(before))!=string(jsonBytes(after)){t.Fatalf("personal viewport changed shared revision/time: %v %v",before,after)}
	ownerRead:=testRequest(router,"GET",path,nil,ownerCookie)
	ownerSnapshot:=object(object(responseRow(t,ownerRead)["project"])["snapshot"])
	if ownerSnapshot["activeChatId"]!="private" { t.Fatalf("private chat lost: %v",ownerSnapshot) }
	viewerRead:=testRequest(router,"GET",path,nil,viewerCookie)
	viewerSnapshot:=object(object(responseRow(t,viewerRead)["project"])["snapshot"])
	if object(viewerSnapshot["viewport"])["x"]!=123.0 || len(viewerSnapshot["chatSessions"].([]any))!=0 { t.Fatalf("personal state leaked: %v",viewerSnapshot) }
	denied:=testRequest(router,"PUT",path,Row{"snapshot":base,"baseSnapshot":base,"expectedRevision":2},viewerCookie)
	if denied.Code!=404 { t.Fatalf("viewer shared write: %d %s",denied.Code,denied.Body.String()) }
	history:=testRequest(router,"POST",path+"/history",Row{"note":"本人历史"},ownerCookie)
	if history.Code!=200{t.Fatalf("history: %d %s",history.Code,history.Body.String())}
	historyID:=str(object(responseRow(t,history)["history"])["id"])
	ownerSnapshot["chatSessions"]=[]any{}
	ownerSnapshot["activeChatId"]=nil
	clear:=testRequest(router,"PUT",path,Row{"snapshot":ownerSnapshot,"baseSnapshot":ownerSnapshot,"expectedRevision":2},ownerCookie)
	if clear.Code!=200{t.Fatalf("clear personal chat: %d %s",clear.Code,clear.Body.String())}
	restored:=testRequest(router,"POST",path+"/history/"+historyID+"/restore",nil,ownerCookie)
	if restored.Code!=200 || object(object(responseRow(t,restored)["project"])["snapshot"])["activeChatId"]!="private" {t.Fatalf("restore personal history: %d %s",restored.Code,restored.Body.String())}
}
