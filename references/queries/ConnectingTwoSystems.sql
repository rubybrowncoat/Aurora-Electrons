with CTE_Variables as
(
	select
		'Your Game Name Here' as GameName
		,'Your Race Name Here' as RaceName 
		,'System 1 Name Here' as System1Name	
		,'System 2 Name Here' as System2Name	
) 

select
	v.*
	,rjps1.WarpPointID as System1_WarpPointID
	,jp1.Distance
	,jp1.Bearing
	,rjps2.WarpPointID as System2_WarpPointID
	,jp2.Distance
	,jp2.Bearing
	
from 
	CTE_Variables as v
inner JOIN
	FCT_Game as g
on
	g.GameName = v.GameName
inner JOIN
	FCT_Race as r
on
	r.GameID = g.GameID
AND
	r.RaceName = v.RaceName
inner JOIN
	FCT_RaceSysSurvey as rss1
on
	rss1.RaceID = r.RaceID
AND
	rss1.Name = v.System1Name
inner JOIN
	FCT_RaceSysSurvey as rss2
on
	rss2.RaceID = r.RaceID
AND
	rss2.Name = v.System2Name
inner JOIN
	FCT_JumpPoint as jp1
on
	jp1.SystemID = rss1.SystemID
inner JOIN
	FCT_JumpPoint as jp2
on
	jp2.SystemID = rss2.SystemID
inner JOIN
	FCT_RaceJumpPointSurvey as rjps1
on
	rjps1.RaceID = r.RaceID
AND	
	rjps1.WarpPointID = jp1.WarpPointID
AND	
	rjps1.Charted = 1
AND
	rjps1.Explored = 0
inner JOIN
	FCT_RaceJumpPointSurvey as rjps2
on
	rjps2.RaceID = r.RaceID
AND	
	rjps2.WarpPointID = jp2.WarpPointID
AND	
	rjps2.Charted = 1
AND
	rjps2.Explored = 0