CREATE INDEX calls_status_created ON calls(status,created_at);
--> statement-breakpoint
CREATE INDEX calls_retention ON calls(ended_at,legal_hold);
--> statement-breakpoint
CREATE INDEX payouts_status ON payouts(status);
--> statement-breakpoint
CREATE INDEX audit_entity ON audit(entity,entity_id);
--> statement-breakpoint
CREATE INDEX sessions_expiry ON sessions(expires_at);
--> statement-breakpoint
CREATE TRIGGER calls_validate_insert BEFORE INSERT ON calls BEGIN
 SELECT CASE WHEN NEW.fare<0 OR NEW.amount<0 OR NEW.fare>100000000 OR NEW.amount>100000000 THEN RAISE(ABORT,'invalid amount') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND status='active') THEN RAISE(ABORT,'member inactive') END;
END;
--> statement-breakpoint
CREATE TRIGGER calls_validate_update BEFORE UPDATE ON calls BEGIN
 SELECT CASE WHEN NEW.fare<0 OR NEW.amount<0 OR NEW.fare>100000000 OR NEW.amount>100000000 THEN RAISE(ABORT,'invalid amount') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.updated_by AND status='active') THEN RAISE(ABORT,'member inactive') END;
 SELECT CASE WHEN OLD.status!=NEW.status AND NOT ((OLD.status='waiting' AND NEW.status IN ('accepted','cancelled')) OR (OLD.status='accepted' AND NEW.status IN ('running','completed','cancelled')) OR (OLD.status='running' AND NEW.status IN ('completed','cancelled'))) THEN RAISE(ABORT,'invalid transition') END;
 SELECT CASE WHEN NEW.status IN ('accepted','running','completed') AND NEW.assignee IS NULL THEN RAISE(ABORT,'missing assignee') END;
 SELECT CASE WHEN OLD.status!=NEW.status AND NEW.status IN ('running','completed') AND NEW.updated_by!=OLD.assignee THEN RAISE(ABORT,'assignee only') END;
 SELECT CASE WHEN (OLD.legal_hold!=NEW.legal_hold OR OLD.retain_until IS NOT NEW.retain_until) AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.updated_by AND role='admin' AND status='active') THEN RAISE(ABORT,'admin only') END;
END;
--> statement-breakpoint
CREATE TRIGGER calls_created AFTER INSERT ON calls BEGIN
 INSERT INTO audit(entity,entity_id,action,actor,after,created_at) VALUES('call',NEW.id,'새 콜 등록',NEW.created_by,json_object('origin',NEW.origin,'destination',NEW.destination,'fare',NEW.fare,'amount',NEW.amount,'departure',NEW.departure,'notes',NEW.notes,'status',NEW.status),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER calls_changed AFTER UPDATE ON calls BEGIN
 INSERT INTO audit(entity,entity_id,action,actor,before,after,created_at) VALUES('call',NEW.id,CASE WHEN OLD.status!=NEW.status THEN CASE NEW.status WHEN 'accepted' THEN '배차 수락' WHEN 'running' THEN '운행 시작' WHEN 'completed' THEN '배차 완료' WHEN 'cancelled' THEN '콜 취소' ELSE '콜 수정' END ELSE '콜 수정' END,NEW.updated_by,json_object('origin',OLD.origin,'destination',OLD.destination,'fare',OLD.fare,'amount',OLD.amount,'status',OLD.status,'departure',OLD.departure,'notes',OLD.notes,'assignee',OLD.assignee,'reason',OLD.reason,'legal_hold',OLD.legal_hold,'retain_until',OLD.retain_until),json_object('origin',NEW.origin,'destination',NEW.destination,'fare',NEW.fare,'amount',NEW.amount,'status',NEW.status,'departure',NEW.departure,'notes',NEW.notes,'assignee',NEW.assignee,'reason',NEW.reason,'legal_hold',NEW.legal_hold,'retain_until',NEW.retain_until,'retention_reason',NEW.retention_reason),NEW.updated_at);
 INSERT INTO payouts(id,call_id,amount,updated_by,updated_at) SELECT NEW.id,NEW.id,NEW.amount,NEW.updated_by,NEW.updated_at WHERE NEW.status='completed' AND OLD.status!='completed';
END;
--> statement-breakpoint
CREATE TRIGGER payout_validate BEFORE UPDATE ON payouts BEGIN
 SELECT CASE WHEN NEW.amount<0 OR NEW.amount>100000000 THEN RAISE(ABORT,'invalid amount') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.updated_by AND status='active') THEN RAISE(ABORT,'member inactive') END;
 SELECT CASE WHEN OLD.status!=NEW.status AND NOT ((OLD.status='pending' AND NEW.status IN ('paid','cancelled')) OR (OLD.status='paid' AND NEW.status='cancelled')) THEN RAISE(ABORT,'invalid payment transition') END;
END;
--> statement-breakpoint
CREATE TRIGGER payout_created AFTER INSERT ON payouts BEGIN
 INSERT INTO audit(entity,entity_id,action,actor,after,created_at) VALUES('payout',NEW.id,'지급 대기 생성',NEW.updated_by,json_object('amount',NEW.amount,'status',NEW.status),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER payout_changed AFTER UPDATE ON payouts BEGIN
 INSERT INTO audit(entity,entity_id,action,actor,before,after,created_at) VALUES('payout',NEW.id,CASE WHEN NEW.status!=OLD.status THEN CASE NEW.status WHEN 'paid' THEN '지급 완료' ELSE '지급 취소' END ELSE '지급 수정' END,NEW.updated_by,json_object('amount',OLD.amount,'status',OLD.status,'notes',OLD.notes,'processed_by',OLD.processed_by,'processed_at',OLD.processed_at,'reason',OLD.reason),json_object('amount',NEW.amount,'status',NEW.status,'notes',NEW.notes,'processed_by',NEW.processed_by,'processed_at',NEW.processed_at,'reason',NEW.reason),NEW.updated_at);
 UPDATE calls SET amount=NEW.amount,updated_by=NEW.updated_by,updated_at=NEW.updated_at,version=version+1 WHERE id=NEW.call_id AND amount!=NEW.amount;
END;
--> statement-breakpoint
CREATE TRIGGER calls_guard_delete BEFORE DELETE ON calls BEGIN
 SELECT CASE WHEN OLD.legal_hold=1 OR OLD.retain_until IS NULL OR OLD.retain_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') OR OLD.status NOT IN ('completed','cancelled') OR EXISTS(SELECT 1 FROM payouts WHERE call_id=OLD.id AND status='pending') THEN RAISE(ABORT,'protected record') END;
END;
--> statement-breakpoint
CREATE TRIGGER calls_deleted AFTER DELETE ON calls BEGIN
 DELETE FROM audit WHERE entity_id=OLD.id AND entity IN ('call','payout');
 INSERT INTO audit(entity,entity_id,action,actor,created_at) VALUES('cleanup',OLD.id,'보관 해제 자료 삭제','system',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
