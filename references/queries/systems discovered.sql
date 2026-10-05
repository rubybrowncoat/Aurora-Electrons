with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	rss.Name as Sys
FROM
	FCT_RaceSysSurvey as rss
inner join
	CTE_Const
on
	CTE_Const.RaceID = rss.RaceID