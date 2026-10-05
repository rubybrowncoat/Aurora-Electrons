--select distinct BodyClass from FCT_SystemBody

select rss.Name as System, sb.PlanetNumber as Planet
, case when lp.LagrangePointID is null then 'No' else 'Yes' end as HasLP
, case when lp.LagrangePointID is null then round(5/sqrt(sb.mass),2) else '--' end as LGYrs
from FCT_SystemBody as sb
inner join FCT_SystemBodySurveys as sbs on sbs.SystemBodyID = sb.SystemBodyID
inner join FCT_Race as r on r.RaceID = sbs.RaceID
inner join FCT_RaceSysSurvey as rss on rss.RaceID = sbs.RaceID and rss.SystemID = sb.SystemID
left join FCT_LagrangePoint as lp on lp.PlanetID = sb.SystemBodyID
where sb.BodyTypeID in (4,5)
and sb.GameID = (select max(gameid) as g from fct_game)
and r.RaceID = (select max(raceid) as r from FCT_Race where NPR=0)
order by rss.Name, sb.PlanetNumber