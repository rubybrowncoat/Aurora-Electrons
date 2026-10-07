--drop view vw_jumppoints;
--select * from vw_jumppoints
--create view vw_jumppoints as

SELECT
	--'JP' || rss.Name || '-' || rss1_dest.Name as JP1_ID --  jp1.WarpPointID as JP1_ID
	--,'JP' || rss.Name || '-' || rss2_dest.Name as JP2_ID --  jp2.WarpPointID as JP1_ID
	rss.RaceID
	,rss.SystemID
	,rss.Name as SystemName
	--,
	,rss1_dest.Name as DestinationName
	,jp1.Xcor
	,jp1.Ycor
	,jp1.WarpPointID
	,jp2.WarpPointID as WarpPointID_dest
	--,(jp1.Xcor-jp2.Xcor)*(jp1.Xcor-jp2.Xcor)+(jp1.Ycor-jp2.Ycor)*(jp1.Ycor-jp2.Ycor) as distanceSquared
	--,*
FROM
	FCT_RaceSysSurvey as rss
inner JOIN
	FCT_JumpPoint as jp1
on
	jp1.SystemID = rss.SystemID
inner JOIN
	FCT_JumpPoint as jp2
on
	jp2.WarpPointID = jp1.WPLink
inner JOIN
	FCT_RaceJumpPointSurvey as rjps1
on
	rjps1.RaceID = rss.RaceID
AND
	rjps1.WarpPointID = jp1.WarpPointID
AND
	rjps1.Explored = 1

inner JOIN
	FCT_RaceJumpPointSurvey as rjps1_Dest
on
	rjps1_Dest.RaceID = rss.RaceID
AND
	rjps1_Dest.WarpPointID = jp1.WPLink
AND
	rjps1_Dest.Explored = 1

inner JOIN
	FCT_JumpPoint as jp1_Dest
on
	jp1_Dest.WarpPointID = jp1.WPLink

inner JOIN
	FCT_RaceSysSurvey as rss1_dest
on
	rss1_dest.RaceID = rss.RaceID
AND
	rss1_dest.SystemID = jp1_Dest.SystemID
/*
inner JOIN
	FCT_RaceJumpPointSurvey as rjps2
on
	rjps2.RaceID = rss.RaceID
AND
	rjps2.WarpPointID = jp2.WarpPointID
AND
	rjps2.Explored = 1
inner JOIN
	FCT_RaceJumpPointSurvey as rjps2_Dest
on
	rjps2_Dest.RaceID = rss.RaceID
AND
	rjps2_Dest.WarpPointID = jp2.WPLink
AND
	rjps2_Dest.Explored = 1

inner JOIN
	FCT_JumpPoint as jp2_Dest
on
	jp2_Dest.WarpPointID = jp2.WPLink

inner JOIN
	FCT_RaceSysSurvey as rss2_dest
on
	rss2_dest.RaceID = const.RaceID
AND
	rss2_dest.SystemID = jp2_Dest.SystemID
*/
--where rss.Name like 'A%'
--and rss.RaceID = 279