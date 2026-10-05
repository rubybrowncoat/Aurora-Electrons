DROP VIEW IF EXISTS "main"."vw_const";
CREATE VIEW vw_const as

	select 
		g.GameID
		,r.RaceID
		,g.GameTime
	from 
		FCT_Game as g
	inner join FCT_Race as r on r.GameID = g.GameID and r.NPR = 0
	order by 
		g.GameID desc
		,r.RaceID desc
	limit 1