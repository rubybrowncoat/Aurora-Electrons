--create table tmp_Fleet as select * from FCT_Fleet where FleetID = 137945

--select * from tmp_Fleet

--create table tmp_Ship as select * from FCT_Ship where FleetID = 137945

--select * from tmp_Ship


select * from FCT_AlienRace as ar where ar.AlienRaceName like 'Fafa%'

select * from FCT_RaceSysSurvey where RaceID = 607

select * from fct_fleet as f
where f.SystemID = 13658
and f.RaceID = 603
order by xcor desc, ycor desc