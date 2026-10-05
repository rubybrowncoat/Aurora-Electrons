--drop view vw_survey;
--create view vw_survey as 
with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	rss.Name as Sys
	,sys.JumpPointSurveyPoints as PtsPerLoc
	,30-IFNULL(LocationsDone.cnt,0) as UnexLocs	
	,'' as AssignedFleets
	,IFNULL(InProgress.cnt,0) as InProgressLocs
	,IFNULL(InProgress.PointsRemaining,0) as InProgressPointsRemaining
	--,st.Mass
	--,*
FROM
	FCT_RaceSysSurvey as rss
inner join
	CTE_Const
on
	CTE_Const.RaceID = rss.RaceID
inner JOIN
	FCT_System as sys
on
	sys.SystemID = rss.SystemID
/*
inner JOIN
	FCT_Star as s
on
	s.SystemID = sys.SystemID
inner JOIN
	DIM_StellarType as st
on
	st.StellarTypeID = s.StarTypeID
AND
	s.Component = 1
*/
left JOIN
(
SELECT
	rsl.SystemID
	,rsl.RaceID
	,count(*) as cnt
from
	FCT_RaceSurveyLocation as rsl
group by
	rsl.SystemID ,rsl.RaceID
) as LocationsDone
on
	rss.RaceID = LocationsDone.RaceID
AND
	rss.SystemID = LocationsDone.SystemID
left JOIN
(
	SELECT
		mo.RaceID
		,mo.StartSystemID as SystemID
		,count(*) as cnt
		,sum(mo.SurveyPointsRequired) as PointsRemaining
	FROM
		FCT_MoveOrders as mo
	WHERE
		mo.DestinationType = 4
	group by
		mo.RaceID
		,mo.StartSystemID
) as InProgress
on
	InProgress.RaceID = rss.RaceID
AND
	InProgress.SystemID = rss.SystemID
